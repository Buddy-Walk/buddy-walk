import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, it } from "vite-plus/test";

import { effectBlockBody } from "./plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const blockBody = [{ messageId: "blockBody" }];

new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } }).run(
  "effect-block-body",
  effectBlockBody,
  {
    valid: [
      "useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [trialId]);",
      "useEffect(() => { const id = setInterval(tick, 1000); return () => clearInterval(id); }, []);",
      "useEffect(onMount, []);",
      "useMemo(() => trials.filter(Boolean), [trials]);",
    ],
    invalid: [
      // The crash on Close in #58: scrollTo returns a Promise, which React called as the cleanup.
      {
        code: "useEffect(() => content.current?.scrollTo({ top: 0 }), [trialId]);",
        errors: blockBody,
      },
      { code: "useLayoutEffect(() => measure(), []);", errors: blockBody },
      { code: "React.useEffect(() => void track(), []);", errors: blockBody },
    ],
  },
);
