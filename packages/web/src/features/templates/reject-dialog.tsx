import { TEMPLATE_REJECTION_REASONS, type RejectTemplateRequest, type TemplateRejectionReason } from "@whaloc/shared";
import { useState } from "react";
import { Dialog } from "../../components/dialog.tsx";

export interface RejectDialogProps {
	templateName: string;
	onClose: () => void;
	onReject: (request: RejectTemplateRequest) => void;
}

/**
 * What a Meta reviewer sends back: the `reason` enum the status webhook carries, plus the
 * free-text `rejection_info` pair (SPEC §4). Both fields are optional in the contract; leaving
 * them empty rejects with the defaults, exactly like a bare `POST`.
 */
export function RejectDialog(props: RejectDialogProps) {
	const [reason, setReason] = useState<TemplateRejectionReason>("INVALID_FORMAT");
	const [detail, setDetail] = useState("");
	const [recommendation, setRecommendation] = useState("");

	const submit = (): void => {
		const rejectionInfo =
			detail.trim() === "" || recommendation.trim() === ""
				? undefined
				: { reason: detail.trim(), recommendation: recommendation.trim() };

		props.onReject({ reason, ...(rejectionInfo !== undefined && { rejectionInfo }) });
	};

	return (
		<Dialog
			title="Reject template"
			subtitle={props.templateName}
			onClose={props.onClose}
			footer={
				<>
					<button type="button" className="button" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" className="button button--danger" onClick={submit}>
						Reject
					</button>
				</>
			}
		>
			<label className="field">
				<span className="field__label">Reason</span>
				<select
					className="select"
					value={reason}
					onChange={event => {
						setReason(event.target.value as TemplateRejectionReason);
					}}
				>
					{TEMPLATE_REJECTION_REASONS.map(candidate => (
						<option key={candidate} value={candidate}>
							{candidate}
						</option>
					))}
				</select>
			</label>

			<label className="field">
				<span className="field__label">rejection_info.reason</span>
				<input
					className="input"
					placeholder="What the reviewer objected to"
					value={detail}
					onChange={event => {
						setDetail(event.target.value);
					}}
				/>
			</label>

			<label className="field">
				<span className="field__label">rejection_info.recommendation</span>
				<input
					className="input"
					placeholder="What to change"
					value={recommendation}
					onChange={event => {
						setRecommendation(event.target.value);
					}}
				/>
			</label>

			<p className="faint">Both free-text fields are sent only when filled in; otherwise whaloc uses its defaults.</p>
		</Dialog>
	);
}
