import { setToken } from "./api";
import { h, replace } from "./dom";
import { renderList } from "./list";
import { renderSession, type Tab } from "./session";

const root = document.getElementById("app") as HTMLElement;
const params = new URLSearchParams(location.search);
const token = params.get("token");

let generation = 0;

function route(): void {
  const mine = ++generation;
  const isCurrent = () => mine === generation;
  let parts: string[];
  try {
    parts = location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .map((p) => decodeURIComponent(p));
  } catch {
    parts = [];
  }
  if (parts[0] === "s" && parts[1] && parts[2]) {
    const tab = (
      ["records", "timeline", "raw"].includes(parts[3] ?? "") ? parts[3] : "records"
    ) as Tab;
    renderSession(root, parts[1], parts[2], tab, isCurrent);
  } else {
    renderList(root, isCurrent);
  }
  window.scrollTo(0, 0);
}

if (!token) {
  replace(
    root,
    h(
      "p",
      { role: "alert" },
      "This page needs the address `seshi explore` printed: it carries a token. Run seshi explore again for a new one.",
    ),
  );
} else {
  setToken(token);
  history.replaceState(null, "", `${location.pathname}${location.hash}`);
  window.addEventListener("hashchange", route);
  route();
}
