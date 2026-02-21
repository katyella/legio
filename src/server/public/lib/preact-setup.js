// Legio Web UI — Preact setup barrel re-export.
// Re-exports Preact primitives for view components.
// Uses bare specifiers resolved by the importmap in index.html.

export { computed, signal } from "@preact/signals";
export { html } from "htm/preact";
export { h, render } from "preact";
export { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
