// A stable board URL for the TV (docs/DESIGN-WAIVERS.md 2.1): the root
// dispatcher in app/page.tsx only redirects when pathname === "/", so /board
// always renders the live board/squads/ledger handoff untouched, even during
// a waiver period when "/" itself bounces to /phase/[seq].
export { default } from "../page";
