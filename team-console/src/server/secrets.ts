import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { secretStatus } from "#/lib/secrets";

export const getSecretStatus = createServerFn().handler(() => secretStatus(env));

export const secretStatusQuery = queryOptions({
  queryKey: ["secret-status"],
  queryFn: () => getSecretStatus(),
});
