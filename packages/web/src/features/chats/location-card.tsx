/** A shared location as WhatsApp shows it: the pin, the place, then the coordinates. */
export function LocationCard(props: {
	latitude: number | null;
	longitude: number | null;
	name: string | null;
	address: string | null;
}) {
	const { latitude, longitude, name, address } = props;

	return (
		<div className="bubble__location">
			<span className="bubble__location-pin" aria-hidden="true">
				◎
			</span>
			<div>
				{name !== null && <p className="bubble__text">{name}</p>}
				{address !== null && <p className="muted">{address}</p>}
				<p className="faint mono">
					{latitude?.toFixed(5) ?? "?"}, {longitude?.toFixed(5) ?? "?"}
				</p>
			</div>
		</div>
	);
}
