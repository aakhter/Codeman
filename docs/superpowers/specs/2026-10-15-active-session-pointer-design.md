# COD-522: Active session pointer

User approved option A from the comparison mockup: a solid inward-pointing marker on the selected session row, supplementing color. Reserve the marker's space on inactive rows. Keep status dots, agent logos, row actions, focus styling and attention effects independent.

Render one empty decorative span before each session row's number/status. CSS shows it only for `.active`, points it right in vertical rails/sidebar and down in horizontal tabs, and uses the theme's text color. Use a real child element because row pseudo-elements already carry loading and attention effects. In the collapsed sidebar, position the marker at the leading edge so it does not crowd badges. Selection updates use existing active-class changes; synchronize `aria-selected` on incremental updates too.

Validate the real renderer and incremental selection, no active marker for attention/hover alone, stable marker gutter, light/dark skins, compact/grouped rails, horizontal/mobile strips, and collapsed sidebar. Application deployment is a separate action.
