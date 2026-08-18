# COD-326: Session Options Responsive Layout

## Problem

The Session Options **Session** panel chooses a two-column grid at a viewport width of 680px, but the panel does not own the full viewport. At the reported 974 CSS-pixel viewport, the modal is 900px wide, the navigation rail consumes 236px, and the document pane is only 618px wide. The two grid columns have content-based minimum sizes, expand to 640px, and force horizontal scrolling and clipped controls.

The grid breakpoint is therefore based on the wrong constraint. The layout must account for the modal rail and the minimum usable width of each settings group.

## Approved Behavior

- Session Options must never require horizontal scrolling at supported desktop, tablet, or phone widths.
- The Session panel uses one column at ordinary desktop and tablet widths, including the reported 974px viewport.
- On genuinely wide windows, Session Options may widen and the Session panel uses two equal columns.
- The Session heading and introductory description span the full document width in the two-column layout.
- Existing navigation, vertical scrolling, controls, save behavior, phone layout, and the other Session Options panels remain unchanged.

## Layout Design

The current Session Options modal keeps its existing maximum width and single-column Session panel by default. A wide-screen media query, beginning at 1200px, increases only this modal's maximum width to 1120px and changes `#context-tab` to two `minmax(0, 1fr)` tracks.

At 1200px and above, the 236px navigation rail leaves roughly 840px or more for the document after borders and padding, giving each settings group enough usable width. The section heading and blurb span both tracks. Below 1200px, the panel is a single column and therefore fits inside the existing 618px document pane at the reported viewport.

This replaces the old 680px viewport rule. It does not add horizontal clipping or hide overflow; content is allowed to wrap naturally and the existing vertical document scroller remains authoritative.

## Testing

A real Chromium regression will render the shipping Session Options markup and styles at:

- 974px viewport width: the Session document and panel have equal `scrollWidth`/`clientWidth`, the panel is one column, and controls stay within the document bounds.
- 1440px viewport width: the modal is wider, the panel has two equal columns, the heading and blurb span the document, and no horizontal overflow occurs.

The existing structural and layout tests will remain green. The browser-driven test will be registered in the repository's browser-test exclusion list because CI environments may not have Chromium installed.

## Scope

This is a CSS-only responsive-layout correction plus focused regression coverage. It does not redesign the settings cards, change setting values, alter session persistence, or modify App Settings and Add Case behavior.
