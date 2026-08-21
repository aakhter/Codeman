# Case Management default session group

## Goal

Configure a case's default session group from the **Edit Case** form in Case Management, rather than from the quick-start toolbar. The saved value continues to control where future sessions for that case are placed.

## Scope

- Show a `Default session group` select while editing every case type: local, linked-local, remote, and Docker.
- Populate it with `Ungrouped` plus the authenticated user's current named vertical-rail groups.
- Load the saved case default when the Edit Case modal opens.
- Save the selected group as part of the existing case-update action.
- Remove the duplicated desktop and mobile quick-start-toolbar controls and their handlers.

Creating a case does not set a default group. The group is configured after the case exists through Edit Case.

## Data flow

1. `editCase(name)` opens the correct case-type panel and requests the current default and selectable groups.
2. The shared select is disabled until that request settles. It always offers `Ungrouped`, represented as `null` in persistence.
3. The Edit Case Save request carries the selected `defaultGroupId` with the normal case update payload.
4. The case update route validates that a non-null group exists in the current owner's authoritative layout, updates the case, then persists the default under the final case name. Case rename continues to move the stored setting correctly.
5. Session creation retains its existing precedence: explicit group, eligible represented parent, valid case default, then Ungrouped.

## Failure behavior

- A default-group load failure leaves the select disabled and reports the error; the user cannot accidentally overwrite a saved value.
- A rejected save keeps the Edit Case modal open and shows the server error.
- A group deleted elsewhere is normalized to `Ungrouped` by the existing server-side validation.

## Verification

- Structural UI tests assert the selector exists in Edit Case and does not exist in the toolbar popovers.
- Browser/UI tests cover opening an edit form, rendering the selected default, saving a different group, and switching between case types.
- Route tests cover validation, rename behavior, and ownership isolation.
- Existing launch and tab-layout tests verify default placement and precedence remain unchanged.
