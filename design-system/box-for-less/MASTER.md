# Box for Less — Customer Catalogue: Design System (MASTER)

Source of truth for how the **customer catalogue** (`/catalog`) looks and behaves.
Staff screens use `styles.css` and are not covered here.

Built with the UI UX Pro Max skill: product-type, style, colour and typography rows from
its data files, its UX rules (`references/quick-reference.md`) and its pre-delivery
checklist (`references/pro-rules.md`). Python is not installed on this machine, so the
skill's `search.py` could not run; the same CSV files were queried directly instead.
Where the data and this project disagree, the project wins (see "Departures").

> **Newest direction — doodle wallpaper and product drawings (supersedes the amber palette
> below).** Every page sits on a black line-art doodle wallpaper (`img/doodles-bg.webp`,
> 572×1024, 235 KB, shared via `css/backdrop.css`), veiled in white (70% on a phone; on wide
> screens stronger at the outer edges and veiled to 92% towards the centre, the right half a
> mirror of the left) and drifting very slowly (60s, transform only, off under reduced motion).
> The legibility rule is unchanged: **text never sits on the pattern** — panels, header, tab
> bar and small labels are white; only the big serif words stand on it, in near-black.
> Palette: white, `#f1eee8` pills, ink `#1a1612` (17:1), muted `#57524b` (7.6:1), burnt orange
> `#e4571a`; category tiles are ink, white, orange and oat. Because almost no product has a
> photograph, **each card shows a small line drawing of what kind of thing it is** — a sack for
> rice and flour, a bottle for a drink, a jar for spices, a can, candy, cup, oil bottle, cupcake,
> milk carton, drumstick, wine glass, spray bottle, pump bottle, toilet roll, box, paw, bowl —
> chosen at display time from the product's Odoo category and, for plain food, its name (rice,
> flour, sugar, oats, beans → sack). The drawing sits in a round chip on the card, large on the
> category tiles, and as the hero on a product page that has no photo. No data is changed; the
> rules are in `js/catalog/doodle-map.js` and covered by `test/doodle-map.test.js`.
>
> **Previous direction (amber photograph):**
>
> **Latest direction — grains and honey (supersedes the palette and surfaces below, and the
> blockquote after this one where they differ).** The whole site — catalogue, staff screens,
> sign-in, scanner, front door — sits on one photograph of oats, seeds and honey on amber
> (`img/grains-bg.webp`, 768×1344, 139 KB, shared by `css/backdrop.css`). One layer on a phone;
> from 900px the screen is split into two halves and the right is the same picture mirrored.
> It drifts very slowly (transform only, 42s) and is still under reduced motion.
> **Legibility rule: text never sits on the photograph.** The picture is veiled in amber
> (58% on a phone; on wide screens vivid at the edges and veiled to 90% towards the centre);
> panels, the header, the tab bar and every small label are cream; only the large serif words
> (the big number, section titles) stand on the veiled picture, in deep brown.
> Palette: amber `#d4a04a`, cream `#fffaf0`, oat `#f6ead2`, ink `#26170a` (7.4:1 on the amber,
> 16.6:1 on cream), muted `#5b4520` (8.6:1 on cream), burnt orange `#e4571a` (outlines, badge,
> banner, one tile), brown `#4a2d12`. Staff buttons and links are burnt `#a8400b` (6.2:1 with
> white). Display type is a system serif (Iowan Old Style / Palatino / Georgia) for the big
> words; everything else stays system sans. Focus ring is deep brown. The owner's decisions
> still stand: the thin orange outline + soft shadow on product boxes, and the *Add to request*
> button (orange edge, thin blue inner line, 10px corners).
>
> **Previous direction** (kept for history):
>
> **Current direction (supersedes the poster/colour-block look in §2–§5 where they differ):**
> editorial and bold, after the humbleteam "Content" reference. White page; a very large
> light number ("896 products available now"); headline tabs with the live one dark and
> the other faded; a pill search with a magnifier; category tiles in orange / black /
> two greys with a ↗ arrow and a large title; black pill chips whose live count is an
> orange badge; product tiles with the pack size and ↗ on top and the name set large;
> a floating **bottom tab bar** (Home · Categories · My request; the live tab is a black pill,
> the request count an orange badge) in place of the old cart pill, after the mobile shopping-app
> references; an orange **"Request cartons in three steps"** banner under the big number;
> rounded 28px sheet drawer.
>
> **Experience pass:** the carton count is a number you can **tap and type** (48 cartons is one
> entry, not 48 taps; 0 removes the line; garbage puts the old value back) in the card, the
> product page and the drawer; the header slips away on scroll-down and returns on scroll-up;
> the big number counts up to its value; moving between list and product fades and rises; the
> stepper pops in and the tab badge bumps when something is added; photos fade in once loaded;
> loading tiles are the shape of real tiles; "Clear filters" appears whenever anything narrows
> the list and is offered on the empty state. All of it is off under reduced motion. Not taken from those references, on purpose: a round "+" instead
> of the Add to request button (the owner's button spec stands), prices, and a brands row (no such data).
> Palette: ink `#111110`, hot orange `#ff6a3d`, tiles `#f2f2f0`; blue `#1a5fd0` only for
> focus, links and the request button's inner line. **Kept from earlier owner decisions:**
> the thin orange outline + soft shadow on every product box, and the *Add to request*
> button (orange edge, thin blue inner line, 10px corners). Motion (scroll reveal, tile
> rise, sheet/bar entrances) is opacity/transform only and off under reduced-motion.
> Accessibility measurements in §3 and §8 still apply; the muted text is now `#66635e`.

---

## 1. Product and audience

| | |
|---|---|
| Product | A phone-first **request catalogue** for a food importer's trade customers. Customers browse what is in stock, add cartons to a request, enter their access code and send it. It is **not a shop**: no prices, no payment, no stock quantities, no reservation. |
| Who | Shop owners and their staff in Ghana, usually on a phone, often outdoors or on a weak connection. Some are salesmen carrying one phone between several customers. |
| Job to be done | Find a product fast, see whether it can be requested, put a number of cartons on the request, send it. |
| Skill match | `E-commerce` → *Vibrant & Block-based* (secondary Motion-Driven); palette `Food Delivery / On-Demand` → **appetising orange + trust blue**; `Marketplace` → *category colours + success green*. |

## 2. Style: "Gallery wall, with colour blocks for navigation"

Two ideas, kept apart so they do not fight:

1. **Products are quiet.** A product is a small framed poster (the BALMUDA reference): white
   frame, pale canvas, the subject alone, a calm caption. Almost no product has a photo
   (8,932 of 8,933), so the canvas carries the **pack size** as a large, light typographic
   subject instead of an empty box.
2. **Navigation is loud.** Categories are big coloured blocks (the Box for Less app):
   yellow, magenta, orange, green. This is where *Vibrant & Block-based* is spent.

Everything else is neutral ink and white, so the colour that remains means something.

## 3. Tokens (`css/catalog.css` `:root`)

### Colour

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--c-bg` | `#ffffff` | page | — |
| `--c-surface` | `#ffffff` | frames, drawer rows, inputs | — |
| `--c-canvas` | `#ebe9e6` | poster paper | — |
| `--c-ink` | `#1c1c1a` | text, selected chips | 17.1:1 on white |
| `--c-muted` | `#6b6862` | captions, counts, placeholders | 5.6:1 white · 4.6:1 canvas |
| `--c-line` | `#e4e2de` | hairlines | decorative |
| `--c-orange` | `#ee8a2b` | thin outline of product frames and the request button | **decorative only** (2.5:1) — never carries meaning alone |
| `--c-blue` | `#1a5fd0` | primary actions, round +/− buttons, request-button inner line, links | 5.9:1 on white; white on blue 5.9:1 |
| `--c-focus` | `#1a5fd0` | keyboard focus ring (3px, offset 2px) | ≥3:1 |
| `--c-yellow` `#ffd23f` · `--c-magenta` `#b5179e` · `--c-tangerine` `#f58a1f` · `--c-green` `#4cc26b` | category tiles | ink on yellow 11.8 · white on magenta 5.9 · ink on tangerine 6.9 · ink on green 7.5 |
| `--c-in` `#2f7d4f` · `--c-limited` `#a8741a`/dot `#d49a2a` · `--c-out` `#b0413a` | availability dot only | the **word** carries the meaning |

Rules: colour is never the only signal (availability = dot **and** word; selected chip =
fill **and** `aria-pressed`). Any text on a coloured block is checked against the table above
before the block is changed. Light theme only (`color-scheme: light`); a dark theme was
not requested and would need its own contrast pass.

### Type

System stack only: `-apple-system, "Segoe UI", "Helvetica Neue", Roboto, Arial`.
**Departure from the skill:** its pairings (Poppins, Plus Jakarta Sans, Nunito…) load from a
font CDN. This project forbids CDNs so the app works offline on any network, and a webfont
also costs layout shift on a weak connection.

| Role | Size / weight | Where |
|---|---|---|
| Section | 18px / 800 | "Shop by Category" |
| Tile name | 17px / 800 | category tiles |
| Product name | 13px / 600 | poster caption |
| Detail title | 22px / 600 | product page |
| Body | 16px / 400 | inputs, drawer text |
| Caption / label | **12px minimum**, 600, letter-spaced | category, pack, availability, field labels |
| Pack mark | `clamp(22px, 7vw, 32px)` / 300 | poster subject |

Nothing readable is below 12px. (The decorative corner wordmark is 9px and `aria-hidden`.)

### Space, shape, depth

- 4/8 rhythm: 4 · 8 · 12 · 16 · 24 · 32. Page gutter 16px. Grid gap 12 → 18 → 22px.
- Radius: frames 3px · request button and stepper **10px** · tiles 16px · chips pill · inputs 6px.
- Depth: frame = 1px orange outline + soft grey shadow with a faint orange tint; hover deepens
  the shadow, it never moves the layout. Tiles carry a soft shadow.
- Touch: every control **≥ 44×44px**, ≥ 8px between neighbours (chips 44px tall, +/− are a
  visible 28px circle inside a 44px target).

## 4. Layout and responsive

Mobile-first, one column of content, max width 1100px.

| Width | Product grid | Category tiles |
|---|---|---|
| < 560 | 2 columns | 2 |
| ≥ 560 | 3 | 2 |
| ≥ 760 | 3 + side drawer instead of bottom sheet | 4 |
| ≥ 860 | 4 | 4 |

Order of a list page, top to bottom: header → **Available Now | Full Catalogue** → search →
**Shop by Category** tiles (until a category is chosen or a search is typed, then chips) →
availability chips → count + sort → products → pager. A fixed cart bar appears once
something is added; the page keeps 92px of bottom padding so nothing hides behind it.
Safe-area insets are honoured on the header and the bottom bar.

## 5. Components

| Component | Spec |
|---|---|
| **Header** | Sticky, white at 94%, hairline under. Yellow rounded-square "BFL" mark with ink lettering, name 17px/800, sub-label uppercase 12px. |
| **View tabs** | Two words, 44px tall, 2px ink rule under the live one. `role=tablist`. |
| **Search** | 48px, 16px text (stops iOS zoom), clear button 44px, placeholder uses `--c-muted`. |
| **Category tile** | Button, min-height 112px, radius 16, name + "N products". Cycles yellow → magenta → tangerine → green. |
| **Chip** | 44px, pill, outline; selected = ink fill, white text. Counts in muted. Rows scroll sideways without a scrollbar. |
| **Product frame** | `<article>`-like card: link (poster + caption) and, separately, the request control, so tapping the control never navigates. Poster 4:5 with photo, 5:3 without. Caption: name (3-line clamp) → pack (photo only) → category → availability. |
| **Availability** | 8px dot + 12px word: *In Stock*, *Limited Stock*, *Out of Stock*. Never a quantity. |
| **Request control** | Not requestable → plain note. Otherwise **Add to request** (white, 1px orange edge + inner 1px blue line, radius 10) → becomes a stepper: round blue **−** / **+**, "N CTN". Quantities are whole cartons. |
| **Cart bar** | Fixed bottom: "N CTN · M products" (`role=status`) + blue **Review request**. |
| **Request drawer** | Bottom sheet on phones, 460px side panel ≥ 760. `role=dialog`, `aria-modal`. Focus moves in on open, **Esc** closes, focus returns to the opener. Lifts above the on-screen keyboard (`--c-kb`). Contents: lines (stepper + remove), the customer block (code entry → confirmed company name in a green panel), delivery address, notes, Clear / Submit. Submit is grey until a code is accepted, then turns blue and takes focus. |
| **Toast / notices** | Notices live inside the drawer next to what they describe. Counts announce via `role=status`; nothing steals focus. |

## 6. States

| State | Behaviour |
|---|---|
| Loading | Six skeleton frames with a slow shimmer (off under reduced motion). No spinner. |
| Empty | "No products found" + the reason ("Nothing matches “x”. Try a different name or barcode."). |
| Error | Message with the server's reason, in a tinted box. Retry = change a filter. |
| No photo | Poster with the pack size as its subject. |
| Photo fails to load | The poster shows "No product image available"; the filename is never shown. |
| Disabled | Grey fill, muted text, native `disabled`. |
| Not requestable | "Not available to request right now" instead of a control. |
| Stock stale | Drawer shows an amber notice; Submit stays disabled. |

## 7. Motion

Purposeful and short; opacity and transform only, never width/height/top/left. Under
`prefers-reduced-motion` every animation, transition and smooth scroll is off.

| Motion | Spec |
|---|---|
| Page scroll | `scroll-behavior: smooth`; `scroll-padding-top: 76px` keeps targets clear of the sticky header |
| Product frames | Fade + rise 14px over 320ms the first time they scroll into view (IntersectionObserver, `useReveal`). Added by JavaScript only, so nothing is hidden without it |
| Category / front-door tiles | Rise 16px, 400ms, staggered 60ms |
| Cart bar | Slides up 280ms |
| Request drawer | Backdrop fades 220ms; sheet rises (phone) or slides in (side panel) 300ms |
| Chip rows | Smooth horizontal scroll with proximity snapping |
| Press / hover | 150-180ms colour and shadow only; never moves layout |
| Loading | Skeleton shimmer 1.4s |
| Easing | ease-out / `cubic-bezier(.2,.8,.2,1)` for entrances |

## 8. Accessibility (WCAG 2.2 AA target)

- Visible focus ring on every control: 3px blue (`:focus-visible`), or the search field's own 2px ink ring. Never `outline: none` on a control.
- Native `button` / `a` / `input` / `select` everywhere; icon-only controls (×, +, −) have `aria-label`.
- Decorative marks are `aria-hidden`; the product name is the link's name.
- Tabs use `role=tablist` / `aria-selected`; chips use `aria-pressed`.
- Result and cart counts are polite live regions. The page is **not** one big live region.
- On moving between list and product, focus goes to `<main>`; not on first load.
- Back button restores filters, search and page (state lives above the router). Product URLs are deep links.
- Drawer: focus into dialog, Esc, focus return. Sticky bar never covers a focused field (bottom padding + keyboard lift).
- iOS: access-code field keeps `autocomplete="off"`, `inputmode="text"` — see the comment in `RequestUI.js` before touching it.

## 9. Anti-patterns for this product

- Showing any price, any stock number, or an internal id (Phase 1 rule — the API does not send them).
- Emoji as icons; mixing filled and outline icons.
- Hover-only affordances; text under 12px; grey-on-grey.
- Loading fonts, icons or scripts from a CDN.
- A button that looks active but is not (Submit before a code is accepted).
- Rebuilding a container that holds a focused field while the person types.

## 10. Departures from the skill, and why

| Skill says | This project | Reason |
|---|---|---|
| Webfont pairing | System fonts | No CDN; offline; no layout shift |
| `E-commerce` palette = success green primary | Orange + blue, green only for "in stock" and tiles | Owner's brand direction (orange/blue lines, Box for Less app palette) |
| Vibrant style → large 48px+ gaps, 32px+ type | Used only on category tiles | A 900-product list needs density |
| Orange `#EA580C` accent | `#ee8a2b`, decorative only | Fails 3:1 as a boundary; meaning is carried by the blue line and the text |

## 11. Pre-delivery checklist (from `pro-rules.md`) — status

- [x] Text contrast ≥ 4.5:1 (measured above); placeholder and counts fixed from 2.7 and 3.5.
- [x] Touch targets ≥ 44px (chips 38→44, tabs 42→44, clear and remove 36→44).
- [x] Visible focus ring; reduced-motion; no emoji icons; decorative marks hidden from AT.
- [x] Dialog focus, Esc, focus return; counts as polite status.
- [x] Safe-area insets; content not hidden behind the cart bar.
- [x] Checked at 414px and 1100px. Measured in the browser: no control under 44px, no text under 12px except the hidden decorative mark; keyboard focus ring, dialog focus/Esc/return and focus-on-navigation all verified.
- [ ] Not yet checked: 375px landscape; largest system text size; a real phone's keyboard behaviour.
- [ ] Dark mode: intentionally not provided.
