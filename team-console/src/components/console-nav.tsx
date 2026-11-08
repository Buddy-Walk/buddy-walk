import { Link } from "@tanstack/react-router";

const linkProps = {
  activeProps: { className: "font-medium text-foreground" },
  inactiveProps: { className: "text-muted-foreground hover:text-foreground" },
};

export function ConsoleNav() {
  return (
    <nav
      aria-label="Team console"
      className="flex items-center gap-4 border-b bg-card px-6 py-2 text-sm"
    >
      <Link to="/" className="font-semibold">
        Team console
      </Link>
      <Link to="/trials" {...linkProps}>
        Trials
      </Link>
      <Link to="/usage" {...linkProps}>
        Usage
      </Link>
    </nav>
  );
}
