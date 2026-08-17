# COD-315: Dismissible Group Menu

## Problem

The group overflow menu has no managed open/close lifecycle. It cannot close on an outside press, and invoking the same trigger removes and immediately recreates it. Escape only works while focus remains inside the popup.

## Design

Add a dedicated group-menu lifecycle to the browser app. The app retains the active popup, its trigger, and transient document listeners. One close path removes the popup and listeners, clears `aria-expanded`, and optionally restores focus.

- Outside `pointerdown` closes without preventing the underlying interaction or executing an action.
- Escape closes from anywhere while the menu is open and restores focus to its trigger.
- Invoking the same trigger toggles the menu closed; another trigger replaces it.
- Activating a menu item closes first and then runs exactly that item action.
- The trigger exposes `aria-haspopup="menu"` and managed `aria-expanded`; the first enabled item receives initial focus and existing arrow navigation remains.

## Verification

Focused DOM tests cover outside dismissal, Escape and focus restoration, same/different trigger behavior, zero actions on dismissal, one action on selection, arrow-key wrapping, ARIA state, and listener cleanup across repeated cycles. A browser check confirms that an outside tab click both dismisses the menu and activates the tab.

## Scope

No server, persistence, layout schema, or CSS behavior changes. Other popup implementations remain unchanged.
