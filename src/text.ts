import { replaceControlCharacters } from "@earendil-works/pi-tui";

/** Expand each tab to four spaces before sanitizing control characters for terminal display. */
export const safeText = (text: string) => replaceControlCharacters(text.replaceAll("\t", "    "));
