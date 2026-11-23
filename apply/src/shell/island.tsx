// Islands: the interactive parts of a prerendered page (the header, a
// form). The rest of the page is plain HTML that the browser never turns
// into React, so its text is not shipped again as JS.
//
// At build time (prerender.tsx, inside collectIslands) an Island renders an
// empty container and records its component; each one is then rendered as
// its own root and written into that container. In the browser,
// hydrate.tsx's hydrateIslands() attaches one root per container, with
// the props the container carries in data-props. Each root gets its own
// identifierPrefix, so useId values never collide between islands.
import type { ComponentType } from "react";

export type IslandEntry = { name: string; component: ComponentType<object>; props: object };
let collected: IslandEntry[] | null = null;

export function collectIslands(render: () => string): { html: string; islands: IslandEntry[] } {
  collected = [];
  try {
    return { html: render(), islands: collected };
  } finally {
    collected = null;
  }
}

// `display: contents`, so the container adds no box: a sticky header stays sticky.
export function Island<P extends object>({ name, component: C, props }: { name: string; component: ComponentType<P>; props: P }) {
  if (collected) {
    collected.push({ name, component: C as ComponentType<object>, props });
    return <div className="contents" data-island={name} data-props={JSON.stringify(props)} />;
  }
  // A page hydrated whole (hydrate()) or `npm run dev`: just the component,
  // so its tree is the same as before islands existed.
  return <C {...props} />;
}
