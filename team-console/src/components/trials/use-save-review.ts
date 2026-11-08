import { useMutation, useQueryClient, type Query } from "@tanstack/react-query";

import { detailWithReview, trialsWithReview, type ReviewInput } from "#/lib/trials/review";
import type { Trial, TrialDetail } from "#/lib/trials/schema";
import { saveReview } from "#/server/trials";

/**
 * Saves a Trial's review and shows it everywhere at once, from what mobile/server
 * saved. Only details already loading are reloaded, since each carries about 1 MB of images.
 */
export function useSaveReview(trialId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (review: ReviewInput) => saveReview({ data: { trialId, ...review } }),
    onSuccess: async (saved) => {
      // A detail load begun before the save would answer with the old review.
      // Invalidating can't replace one that has no data yet, so these restart below.
      const loading = queryClient
        .getQueryCache()
        .findAll({ queryKey: ["trial"], fetchStatus: "fetching" });
      const wasLoading = (query: Query) => loading.some((load) => load === query);
      await queryClient.cancelQueries({ predicate: wasLoading });

      queryClient.setQueriesData<Trial[]>(
        { queryKey: ["trials"] },
        (trials) => trials && trialsWithReview(trials, trialId, saved),
      );
      queryClient.setQueriesData<TrialDetail>(
        { queryKey: ["trial"] },
        (detail) => detail && detailWithReview(detail, trialId, saved),
      );
      // Also replaces any reload begun before this save, which would undo it.
      void queryClient.invalidateQueries({ queryKey: ["trials"] });
      void queryClient.refetchQueries({ predicate: wasLoading });
    },
  });
}
