import {
	CompiledQuery,
	SelectQueryNode,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	type Kysely,
	type QueryCompiler,
	type QueryResult,
} from "kysely";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

/**
 * Kysely dialect for Node's built-in `node:sqlite` module (SPEC §6).
 *
 * No published dialect was convincing enough to depend on (the two candidates on npm are
 * single-maintainer packages with barely any adoption, and one pins its own copy of Kysely),
 * so this is the thin driver the SPEC sanctions: the SQL surface — adapter, compiler,
 * introspector — is Kysely's own, only the ~100 lines that talk to `DatabaseSync` are ours.
 *
 * `DatabaseSync` is synchronous and holds a single connection, so queries are serialized
 * through a mutex the way Kysely's own SQLite driver does: without it an `await` inside a
 * transaction would let unrelated queries slip between `begin` and `commit`.
 */
export interface NodeSqliteDialectConfig {
	database: DatabaseSync;
}

export class NodeSqliteDialect implements Dialect {
	readonly #config: NodeSqliteDialectConfig;

	constructor(config: NodeSqliteDialectConfig) {
		this.#config = config;
	}

	createDriver(): Driver {
		return new NodeSqliteDriver(this.#config.database);
	}

	createQueryCompiler(): QueryCompiler {
		return new SqliteQueryCompiler();
	}

	createAdapter(): DialectAdapter {
		return new SqliteAdapter();
	}

	createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
		return new SqliteIntrospector(db);
	}
}

/** Lets one caller at a time use the single underlying connection. */
class ConnectionMutex {
	#promise: Promise<void> | undefined;
	#release: (() => void) | undefined;

	async lock(): Promise<void> {
		while (this.#promise !== undefined) {
			await this.#promise;
		}

		this.#promise = new Promise<void>(resolve => {
			this.#release = resolve;
		});
	}

	unlock(): void {
		const release = this.#release;

		this.#promise = undefined;
		this.#release = undefined;
		release?.();
	}
}

class NodeSqliteDriver implements Driver {
	readonly #database: DatabaseSync;
	readonly #connection: NodeSqliteConnection;
	readonly #mutex = new ConnectionMutex();

	constructor(database: DatabaseSync) {
		this.#database = database;
		this.#connection = new NodeSqliteConnection(database);
	}

	async init(): Promise<void> {
		// The database is opened by the caller (`createDatabase`), which also sets its pragmas.
	}

	async acquireConnection(): Promise<DatabaseConnection> {
		await this.#mutex.lock();

		return this.#connection;
	}

	async beginTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("begin"));
	}

	async commitTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("commit"));
	}

	async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("rollback"));
	}

	async savepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw(`savepoint ${quoteIdentifier(savepointName)}`));
	}

	async rollbackToSavepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw(`rollback to ${quoteIdentifier(savepointName)}`));
	}

	async releaseSavepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw(`release ${quoteIdentifier(savepointName)}`));
	}

	releaseConnection(): Promise<void> {
		this.#mutex.unlock();

		return Promise.resolve();
	}

	destroy(): Promise<void> {
		if (this.#database.isOpen) {
			this.#database.close();
		}

		return Promise.resolve();
	}
}

class NodeSqliteConnection implements DatabaseConnection {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		const statement = this.#database.prepare(compiledQuery.sql);
		const parameters = compiledQuery.parameters.map(parameter => toSqliteInput(parameter));

		// `columns()` is empty for statements that return no rows, which is how the driver
		// tells a `select` (or a `returning` clause) from an `insert`/`update`/`delete`.
		if (statement.columns().length > 0) {
			const rows = statement.all(...parameters);

			return Promise.resolve({ rows: rows.map(row => toPlainRow(row) as R) });
		}

		const { changes, lastInsertRowid } = statement.run(...parameters);

		return Promise.resolve({
			insertId: BigInt(lastInsertRowid),
			numAffectedRows: BigInt(changes),
			rows: [],
		});
	}

	// `node:sqlite` iterates synchronously, but Kysely's `DatabaseConnection` asks for an
	// async iterator, so this generator has nothing to await.
	// eslint-disable-next-line @typescript-eslint/require-await
	async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
		if (!SelectQueryNode.is(compiledQuery.query)) {
			throw new Error("node:sqlite can only stream select queries");
		}

		const statement = this.#database.prepare(compiledQuery.sql);
		const parameters = compiledQuery.parameters.map(parameter => toSqliteInput(parameter));
		const rows = statement.iterate(...parameters);

		for (const row of rows) {
			yield { rows: [toPlainRow(row) as R] };
		}
	}
}

/** Savepoint names are Kysely-generated identifiers, but quoting keeps the SQL well-formed anyway. */
function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * `node:sqlite` binds `null`, numbers, bigints, strings and buffers. Booleans are the one
 * value a repository can reasonably hand over, and SQLite stores them as integers.
 */
function toSqliteInput(value: unknown): SQLInputValue {
	if (typeof value === "boolean") {
		return value ? 1 : 0;
	}

	if (value === undefined) {
		return null;
	}

	return value as SQLInputValue;
}

/** Rows come back with a null prototype; plain objects keep spreads and assertions predictable. */
function toPlainRow(row: Record<string, SQLOutputValue>): unknown {
	return { ...row };
}
