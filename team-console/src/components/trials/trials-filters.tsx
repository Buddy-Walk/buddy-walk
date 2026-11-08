import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select";
import {
  activePreset,
  hasFilters,
  MAX_LIMIT,
  NAVIGATION_MODE_LABELS,
  NAVIGATION_MODES,
  NO_FILTERS,
  PANORAMA_LABELS,
  PRESETS,
  SCENARIOS,
  togglePreset,
  type PresetName,
  type TrialsSearch,
} from "#/lib/trials/filters";
import { OUTCOME_LABELS } from "#/lib/trials/outcome";
import { REVIEW_OUTCOMES } from "#/lib/trials/schema";
import { cn } from "#/lib/utils";

interface TrialsFiltersProps {
  search: TrialsSearch;
  onChange: (patch: Partial<TrialsSearch>) => void;
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A select whose empty option means "All". */
function FilterSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T | undefined;
  options: readonly (readonly [T, string])[];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <Field id={id} label={label}>
      <NativeSelect
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange((event.target.value || undefined) as T | undefined)}
      >
        <NativeSelectOption value="">All</NativeSelectOption>
        {options.map(([option, text]) => (
          <NativeSelectOption key={option} value={option}>
            {text}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

/**
 * The limit reloads the list, so like the old page it applies on the native
 * change event (a spinner click, Enter, or leaving the field), not each keystroke.
 */
function LimitField({ limit, onChange }: { limit: number; onChange: (limit: number) => void }) {
  const [draft, setDraft] = useState(String(limit));
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(String(limit));
  }, [limit]);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const commit = () => {
      const value = Number(input.value);
      if (Number.isInteger(value) && value > 0) onChange(value);
      else setDraft(String(limit));
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, [limit, onChange]);

  return (
    <Field id="limit" label="Limit">
      <Input
        ref={ref}
        id="limit"
        type="number"
        min={1}
        max={MAX_LIMIT}
        className="w-24"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </Field>
  );
}

export function TrialsFilters({ search, onChange }: TrialsFiltersProps) {
  const preset = activePreset(search);
  const choosePreset = (name: PresetName) =>
    onChange({ ...NO_FILTERS, ...togglePreset(search, name) });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <LimitField limit={search.limit} onChange={(limit) => onChange({ limit })} />
        <FilterSelect
          id="mode"
          label="Navigation mode"
          value={search.mode}
          options={NAVIGATION_MODES.map((mode) => [mode, NAVIGATION_MODE_LABELS[mode]] as const)}
          onChange={(mode) => onChange({ mode })}
        />
        <FilterSelect
          id="scenario"
          label="Scenario"
          value={search.scenario}
          options={SCENARIOS.map((scenario) => [scenario, scenario] as const)}
          onChange={(scenario) => onChange({ scenario })}
        />
        <FilterSelect
          id="panorama"
          label="Panorama"
          value={search.panorama}
          options={Object.entries(PANORAMA_LABELS) as [keyof typeof PANORAMA_LABELS, string][]}
          onChange={(panorama) => onChange({ panorama })}
        />
        <FilterSelect
          id="outcome"
          label="Outcome"
          value={search.outcome}
          options={[
            ["unscored", "Not scored yet"] as const,
            ...REVIEW_OUTCOMES.map((outcome) => [outcome, OUTCOME_LABELS[outcome]] as const),
          ]}
          onChange={(outcome) => onChange({ outcome })}
        />
        <Field id="q" label="Destination / address">
          <Input
            id="q"
            placeholder="e.g. CVS"
            className="w-48"
            value={search.q ?? ""}
            onChange={(event) => onChange({ q: event.target.value || undefined })}
          />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Retries</span>
          <Label className="h-9 font-normal">
            <Checkbox
              checked={search.includeRetries}
              onCheckedChange={(checked) => onChange({ includeRetries: checked === true })}
            />
            Show in list
          </Label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Quick filters:</span>
        {(Object.keys(PRESETS) as PresetName[]).map((name) => (
          <Button
            key={name}
            size="xs"
            variant={preset === name ? "default" : "outline"}
            className={cn("rounded-full px-3")}
            aria-pressed={preset === name}
            onClick={() => choosePreset(name)}
          >
            {PRESETS[name].label}
          </Button>
        ))}
        <Button
          size="xs"
          variant="link"
          disabled={!hasFilters(search)}
          onClick={() => onChange(NO_FILTERS)}
        >
          Clear filters
        </Button>
      </div>
    </div>
  );
}
