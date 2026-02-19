// Legio Web UI — Preact setup barrel re-export.
// Re-exports Preact primitives for view components.
// Uses bare specifiers resolved by the importmap in index.html.
export { h, render } from "preact";
export { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "preact/hooks";
export { html } from "htm/preact";
export { signal, computed } from "@preact/signals";
