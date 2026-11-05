// Keep in step with wrangler.jsonc `secrets.required` and .env.example; secrets.test.ts checks both.
export const secretNames = [
  "ADMIN_TOKEN",
  "API_BASE_URL",
] as const satisfies readonly (keyof Env)[];

export type SecretName = (typeof secretNames)[number];

export type SecretStatus = Record<SecretName, boolean>;

/** Reports which secrets hold a value, never the values themselves. */
export function secretStatus(env: Partial<Record<SecretName, string>>): SecretStatus {
  return Object.fromEntries(
    secretNames.map((name) => [name, Boolean(env[name]?.trim())]),
  ) as SecretStatus;
}
