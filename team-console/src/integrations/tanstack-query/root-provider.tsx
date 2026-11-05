import { QueryClient } from "@tanstack/react-query";

export function getContext() {
  const queryClient = new QueryClient({
    defaultOptions: {
      // Above 0 so data loaded during SSR isn't refetched as soon as the page hydrates.
      queries: { staleTime: 60 * 1000 },
    },
  });

  return {
    queryClient,
  };
}

export default function TanstackQueryProvider() {}
