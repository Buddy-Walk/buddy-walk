import type { FormEvent } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import type { DateRange } from "#/lib/usage/export";

function DateField({ name, label, value }: { name: string; label: string; value?: string }) {
  const id = `usage-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} name={name} type="date" defaultValue={value} className="w-44" />
    </div>
  );
}

function dateIn(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" && value ? value : undefined;
}

/** Dates apply together from the button, so a half-typed range doesn't load. */
export function UsageFilters({
  range,
  onApply,
}: {
  range: DateRange;
  onApply: (range: DateRange) => void;
}) {
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onApply({
      since: dateIn(form, "since"),
      until: dateIn(form, "until"),
    });
  };

  return (
    // Keyed by the applied range, so the inputs follow the URL when it changes.
    <form
      key={`${range.since}-${range.until}`}
      onSubmit={apply}
      className="flex flex-wrap items-end gap-3"
    >
      <DateField name="since" label="Since" value={range.since} />
      <DateField name="until" label="Until" value={range.until} />
      <Button type="submit" variant="secondary">
        Apply filters
      </Button>
    </form>
  );
}
