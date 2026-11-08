import { useState, type FormEvent, type ReactNode } from "react";

import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select";
import { Textarea } from "#/components/ui/textarea";
import { ENTRANCE_LABELS, OUTCOME_LABELS, TURN_LABELS } from "#/lib/trials/outcome";
import {
  quickReview,
  reviewFieldsOf,
  reviewFromFields,
  type ReviewFields,
} from "#/lib/trials/review";
import type { ReviewOutcome, Trial } from "#/lib/trials/schema";

import { useSaveReview } from "./use-save-review";

function LabelOptions({ labels }: { labels: Record<string, string> }) {
  return Object.entries(labels).map(([value, label]) => (
    <NativeSelectOption key={value} value={value}>
      {label}
    </NativeSelectOption>
  ));
}

/** One-tap scoring from the table, right after running a Trial. */
export function QuickOutcome({ trial }: { trial: Trial }) {
  const save = useSaveReview(trial._id);
  const value = save.isPending ? save.variables.reviewOutcome : reviewFieldsOf(trial).outcome;

  return (
    <div className="flex flex-col gap-1">
      <NativeSelect
        size="sm"
        className="min-w-52"
        aria-label="Outcome"
        value={value}
        disabled={save.isPending}
        onChange={(event) => {
          const outcome = event.target.value as ReviewOutcome | "";
          if (outcome) save.mutate(quickReview(trial, outcome));
        }}
      >
        <NativeSelectOption value="">Score…</NativeSelectOption>
        <LabelOptions labels={OUTCOME_LABELS} />
      </NativeSelect>
      {save.isError && (
        <p role="alert" className="max-w-48 text-xs whitespace-normal text-destructive">
          Could not save outcome: {save.error.message}
        </p>
      )}
    </div>
  );
}

function ReviewField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A review select whose empty option means unset. */
function ReviewSelect<T extends string>({
  id,
  label,
  placeholder,
  labels,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  labels: Record<T, string>;
  value: T | "";
  onChange: (value: T | "") => void;
}) {
  return (
    <ReviewField id={id} label={label}>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value as T | "")}
      >
        <NativeSelectOption value="">{placeholder}</NativeSelectOption>
        <LabelOptions labels={labels} />
      </NativeSelect>
    </ReviewField>
  );
}

/**
 * The detail's review. A field shows what is saved until it is edited, so the
 * images arriving or a reload never overwrite what the reviewer is typing.
 */
export function ReviewForm({ trial }: { trial: Trial }) {
  const save = useSaveReview(trial._id);
  const [edits, setEdits] = useState<Partial<ReviewFields>>({});
  const [outcomeMissing, setOutcomeMissing] = useState(false);
  const fields = { ...reviewFieldsOf(trial), ...edits };

  const edit = (patch: Partial<ReviewFields>) => {
    setEdits((current) => ({ ...current, ...patch }));
    setOutcomeMissing(false);
    save.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const review = reviewFromFields(fields);
    setOutcomeMissing(!review);
    if (review) save.mutate(review, { onSuccess: () => setEdits({}) });
  };

  return (
    <form onSubmit={submit} aria-label="Review" className="rounded-lg border bg-card p-4">
      <fieldset disabled={save.isPending} className="grid gap-3 sm:grid-cols-3">
        <ReviewSelect
          id="review-outcome"
          label="Outcome (required)"
          placeholder="Choose…"
          labels={OUTCOME_LABELS}
          value={fields.outcome}
          onChange={(outcome) => edit({ outcome })}
        />
        <ReviewSelect
          id="review-turn"
          label="Turn"
          placeholder="Not scored"
          labels={TURN_LABELS}
          value={fields.turn}
          onChange={(turn) => edit({ turn })}
        />
        <ReviewSelect
          id="review-entrance"
          label="Entrance"
          placeholder="Not scored"
          labels={ENTRANCE_LABELS}
          value={fields.entrance}
          onChange={(entrance) => edit({ entrance })}
        />
        <div className="sm:col-span-3">
          <ReviewField id="review-notes" label="Tester Notes">
            <Textarea
              id="review-notes"
              placeholder="What did the participant experience?"
              value={fields.notes}
              onChange={(event) => edit({ notes: event.target.value })}
            />
          </ReviewField>
        </div>
        <div className="flex flex-col gap-3 sm:col-span-3">
          {outcomeMissing && (
            <Alert variant="destructive">
              <AlertDescription>
                Choose an outcome before saving: would get me there, needed a retake, or would not
                get me there.
              </AlertDescription>
            </Alert>
          )}
          {save.isError && (
            <Alert variant="destructive">
              <AlertDescription>Could not save review: {save.error.message}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button type="submit">
              {save.isPending ? "Saving..." : save.isSuccess ? "Saved!" : "Save Review"}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
