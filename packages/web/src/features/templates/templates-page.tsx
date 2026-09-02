import {
	QUALITY_RATINGS,
	TEMPLATE_CATEGORIES,
	TEMPLATE_STATUSES,
	type ListTemplatesQuery,
	type QualityRating,
	type RejectTemplateRequest,
	type Template,
	type TemplateCategory,
	type TemplateStatus,
} from "@whaloc/shared";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { CopyButton } from "../../components/copy-button.tsx";
import { JsonBlock } from "../../components/json-block.tsx";
import { formatTimestamp } from "../../lib/format.ts";
import { useAction, useAppState, useDispatch, useToasts } from "../../store/store.tsx";
import { RejectDialog } from "./reject-dialog.tsx";
import { TemplatePreview } from "./template-preview.tsx";

const STATUS_TONE: Record<TemplateStatus, string> = {
	PENDING: "badge--warn",
	APPROVED: "badge--ok",
	REJECTED: "badge--danger",
	PAUSED: "badge--info",
	DISABLED: "",
};

const QUALITY_TONE: Record<QualityRating, string> = {
	GREEN: "badge--ok",
	YELLOW: "badge--warn",
	RED: "badge--danger",
	UNKNOWN: "",
};

export function StatusBadge(props: { status: TemplateStatus }) {
	return <span className={clsx("badge", STATUS_TONE[props.status])}>{props.status}</span>;
}

/** The moderation actions that make sense from where the template currently is (SPEC §4). */
function TemplateActions(props: { template: Template; onReject: () => void }) {
	const { template } = props;
	const run = useAction();
	const canApprove = template.status !== "APPROVED";

	return (
		<div className="row row--wrap">
			{canApprove && (
				<button
					type="button"
					className="button button--primary"
					onClick={() => {
						run(async () => api.approveTemplate(template.id));
					}}
				>
					{template.status === "PENDING" ? "Approve" : "Approve again"}
				</button>
			)}
			{template.status === "PENDING" && (
				<button type="button" className="button button--danger" onClick={props.onReject}>
					Reject…
				</button>
			)}
			{template.status === "APPROVED" && (
				<button
					type="button"
					className="button"
					onClick={() => {
						run(async () => api.pauseTemplate(template.id));
					}}
				>
					Pause
				</button>
			)}
			{template.status !== "DISABLED" && (
				<button
					type="button"
					className="button"
					onClick={() => {
						run(async () => api.disableTemplate(template.id));
					}}
				>
					Disable
				</button>
			)}
		</div>
	);
}

function QualityPicker(props: { template: Template }) {
	const run = useAction();

	return (
		<div className="row row--wrap">
			<span className="field__label">Quality update</span>
			{QUALITY_RATINGS.filter(rating => rating !== "UNKNOWN").map(rating => (
				<button
					key={rating}
					type="button"
					className={clsx("button button--sm", props.template.qualityScore === rating && "is-current")}
					onClick={() => {
						run(async () => api.setTemplateQuality(props.template.id, rating));
					}}
				>
					{rating}
				</button>
			))}
		</div>
	);
}

/** The drawer: everything about one template, and every review action it can take. */
function TemplateDetail(props: { template: Template; onClose: () => void }) {
	const { template } = props;
	const run = useAction();
	const [rejecting, setRejecting] = useState(false);

	const reject = (request: RejectTemplateRequest): void => {
		setRejecting(false);
		run(async () => api.rejectTemplate(template.id, request));
	};

	return (
		<aside className="drawer">
			<header className="drawer__header">
				<div className="page__title">
					<h2>{template.name}</h2>
					<span className="faint mono">{template.language}</span>
				</div>
				<button type="button" className="button button--ghost button--icon" aria-label="Close" onClick={props.onClose}>
					✕
				</button>
			</header>

			<div className="drawer__body stack">
				<div className="row row--wrap">
					<StatusBadge status={template.status} />
					<span className="badge">{template.category}</span>
					<span className="badge">{template.parameterFormat}</span>
					{template.qualityScore !== null && (
						<span className={clsx("badge", QUALITY_TONE[template.qualityScore])}>quality {template.qualityScore}</span>
					)}
				</div>

				<div className="row">
					<span className="chip">{template.id}</span>
					<CopyButton value={template.id} label="template id" />
				</div>

				{template.rejectedReason !== null && (
					<p className="muted">
						Rejected as <strong>{template.rejectedReason}</strong>
					</p>
				)}

				<section>
					<h3 className="card__title">Preview</h3>
					<TemplatePreview template={template} />
				</section>

				<section>
					<h3 className="card__title">Components</h3>
					<JsonBlock value={template.components} />
				</section>

				<TemplateActions
					template={template}
					onReject={() => {
						setRejecting(true);
					}}
				/>
				<QualityPicker template={template} />
			</div>

			{rejecting && (
				<RejectDialog
					templateName={template.name}
					onReject={reject}
					onClose={() => {
						setRejecting(false);
					}}
				/>
			)}
		</aside>
	);
}

/**
 * The filter bar (SPEC §2.8). It drives the **server**: the same `status`, `category` and
 * `name_or_content` filters `GET /{wabaId}/message_templates` takes, so what the UI shows and
 * what a consumer's filtered listing returns cannot disagree.
 */
function FilterBar(props: {
	filters: TemplateFilterState;
	onChange: (filters: TemplateFilterState) => void;
	total: number | null;
}) {
	const { filters } = props;

	return (
		<>
			<label className="row">
				<span className="field__label">Search</span>
				<input
					className="input"
					type="search"
					aria-label="Search templates by name or content"
					placeholder="name or content"
					value={filters.search}
					onChange={event => {
						props.onChange({ ...filters, search: event.target.value });
					}}
				/>
			</label>
			<label className="row">
				<span className="field__label">Status</span>
				<select
					className="select"
					aria-label="Filter by status"
					value={filters.status}
					onChange={event => {
						props.onChange({ ...filters, status: event.target.value as TemplateStatus | "" });
					}}
				>
					<option value="">all</option>
					{TEMPLATE_STATUSES.map(candidate => (
						<option key={candidate} value={candidate}>
							{candidate}
						</option>
					))}
				</select>
			</label>
			<label className="row">
				<span className="field__label">Category</span>
				<select
					className="select"
					aria-label="Filter by category"
					value={filters.category}
					onChange={event => {
						props.onChange({ ...filters, category: event.target.value as TemplateCategory | "" });
					}}
				>
					<option value="">all</option>
					{TEMPLATE_CATEGORIES.map(candidate => (
						<option key={candidate} value={candidate}>
							{candidate}
						</option>
					))}
				</select>
			</label>
			<span className="faint">{props.total === null ? "loading…" : `${String(props.total)} shown`}</span>
		</>
	);
}

export interface TemplateFilterState {
	search: string;
	status: TemplateStatus | "";
	category: TemplateCategory | "";
}

const NO_FILTERS: TemplateFilterState = { search: "", status: "", category: "" };

/** How long a keystroke waits before it becomes a request. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * `""` means "no filter", which the control plane spells as an absent parameter. The WABA is not
 * a filter in that sense: templates belong to an account, so it is always sent.
 */
function queryOf(filters: TemplateFilterState, wabaId: string | null): ListTemplatesQuery {
	return {
		...(wabaId !== null && { wabaId }),
		...(filters.search.trim() !== "" && { search: filters.search.trim() }),
		...(filters.status !== "" && { status: filters.status }),
		...(filters.category !== "" && { category: filters.category }),
	};
}

/**
 * Templates (SPEC §5): what the app under test created, and the review a Meta moderator would
 * perform. Every action emits the webhook Meta emits, and the list follows `template.changed`
 * — including the auto-approval timer firing on its own.
 *
 * Scoped to **one WABA**, which is where templates live on Meta's side too
 * (`GET /{wabaId}/message_templates`): the breadcrumb's account segment is the whole scope this
 * view has, and it is sent as `wabaId` so a second account's templates never bleed into it.
 */
export function TemplatesPage() {
	const { templates, wabaId } = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [filters, setFilters] = useState<TemplateFilterState>(NO_FILTERS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const query = queryOf(filters, wabaId);
	// The dependency is the *query*, not the draft: typing a space changes neither.
	const queryKey = JSON.stringify(query);

	useEffect(() => {
		const controller = new AbortController();
		const load = async (): Promise<void> => {
			try {
				const listed = await api.listTemplates(JSON.parse(queryKey) as ListTemplatesQuery, {
					signal: controller.signal,
				});

				dispatch({ type: "templates/loaded", templates: listed });
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		};
		// A keystroke must not be a request. The timer is cleared by the cleanup below, so only
		// the last query in a burst ever reaches the server.
		const timer = setTimeout(() => {
			void load();
		}, SEARCH_DEBOUNCE_MS);

		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [queryKey, dispatch, toasts]);

	const visible = templates ?? [];
	const selected = templates?.find(template => template.id === selectedId) ?? null;
	// The scope is not a filter the user can clear, so it does not make the list "filtered".
	const isFiltered = Object.keys(queryOf(filters, null)).length > 0;

	return (
		<div className="page">
			<header className="page__header page__header--wrap">
				<div className="page__title">
					<h1>Templates</h1>
				</div>
				<span className="spacer" />
				<FilterBar filters={filters} onChange={setFilters} total={templates === null ? null : templates.length} />
			</header>

			<div className="split">
				<div className="split__main">
					{visible.length === 0 ? (
						<p className="empty">
							{isFiltered ? (
								<>
									No templates match this filter.{" "}
									<button
										type="button"
										className="link-button"
										onClick={() => {
											setFilters(NO_FILTERS);
										}}
									>
										Clear it
									</button>
									.
								</>
							) : (
								<>
									No templates yet. The app under test creates them through
									<code> POST /{"{wabaId}"}/message_templates</code>.
								</>
							)}
						</p>
					) : (
						<table className="table">
							<thead>
								<tr>
									<th>Name</th>
									<th>Language</th>
									<th>Category</th>
									<th>Status</th>
									<th>Quality</th>
									<th>Updated</th>
								</tr>
							</thead>
							<tbody>
								{visible.map(template => (
									<tr
										key={template.id}
										className={clsx(template.id === selectedId && "is-selected")}
										onClick={() => {
											setSelectedId(template.id);
										}}
									>
										<td>
											<button type="button" className="link-button">
												{template.name}
											</button>
										</td>
										<td className="mono">{template.language}</td>
										<td>{template.category}</td>
										<td>
											<StatusBadge status={template.status} />
										</td>
										<td>
											{template.qualityScore === null ? (
												<span className="faint">—</span>
											) : (
												<span className={clsx("badge", QUALITY_TONE[template.qualityScore])}>
													{template.qualityScore}
												</span>
											)}
										</td>
										<td className="faint">{formatTimestamp(template.updatedAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				{selected !== null && (
					<TemplateDetail
						template={selected}
						onClose={() => {
							setSelectedId(null);
						}}
					/>
				)}
			</div>
		</div>
	);
}
