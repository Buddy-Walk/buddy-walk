// The Team console's own lint rules, loaded by vite.config.ts.
import { definePlugin, defineRule } from "vite-plus/lint/plugins";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

/**
 * React calls whatever an effect returns as its cleanup, so an arrow that returns
 * an expression can hand it something it can't call. With braces, the only
 * cleanup is an explicit return.
 */
export const effectBlockBody = defineRule({
  meta: {
    type: "problem",
    messages: {
      blockBody:
        "Write this effect's callback with braces. React calls whatever an effect returns as its cleanup, and a value that isn't a function, like scrollTo's Promise, crashes the page when it unmounts.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee.type === "MemberExpression" ? node.callee.property : node.callee;
        if (callee.type !== "Identifier" || !EFFECT_HOOKS.has(callee.name)) return;
        const [effect] = node.arguments;
        if (effect?.type === "ArrowFunctionExpression" && effect.body.type !== "BlockStatement") {
          context.report({ node: effect.body, messageId: "blockBody" });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "team-console" },
  rules: { "effect-block-body": effectBlockBody },
});
