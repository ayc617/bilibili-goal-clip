---
version: alpha
colors:
  background: "#f6f7f9"
  surface: "#ffffff"
  surfaceRaised: "#f1f2f3"
  text: "#18191c"
  textSecondary: "#61666d"
  border: "#e3e5e7"
  accent: "#fb7299"
  recommendation: "#00aeec"
typography:
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
rounded:
  small: "8px"
  medium: "12px"
omitted:
  - section: spacing
    reason: "The existing stylesheet has no consistent named global spacing scale; retain component rhythm."
components:
  goalNavigation:
    description: "Fourth panel in the existing Chrome side panel; native form and disclosures."
---

## Overview

GoalClip adds a goal-driven learning workflow to the existing Bilibili Digest extension. Preserve the familiar Bilibili pink/blue accent language, compact system typography and quiet neutral surfaces. This is a product surface for reading subtitle evidence beside a video, not a marketing redesign. Do not add a large hero, decorative backgrounds, new fonts, or unrelated navigation.

## Colors

Runtime ownership remains `sidepanel.css` `:root`; this document records existing tokens rather than generating a second token source. Map background/surface/text/border/accent to `--bg`, `--surface`, `--text`, `--border`, `--accent`. Recommendation marks use `--sage`/`--sage-dim`; playback retains its existing pink `--accent-dim` and left border. Labels distinguish the two states without color alone.

## Typography

Use existing `--font-body`, `--font-reading`, `--font-display` and `--font-mono` system stacks. Chinese copy is primary in the side panel. Keep technical names in their source form. Use the existing section title and button classes; evidence is readable multi-line text, never forced into a truncated single line.

## Layout

The existing `.content` owns vertical scrolling. Fourth-tab content uses natural height and wrapping at narrow sidebar widths. The hierarchy is goal input, ordered recommendations, collapsible evidence, coverage and supplementary search. Existing chapters and debug details are secondary disclosures. Retain subtitle/overview/notes panels in place. Goal input stays transient in memory rather than a URL because it can contain personal learning intentions.

## Elevation & Depth

Reuse `--shadow-sm` for recommendation cards and existing border/surface tokens. No new layers or modal flows.

## Shapes

Reuse `--r-sm` and `--r-md`; small action buttons use the existing `.enhance-btn` pill treatment.

## Components

Use native textarea/label/form/button for goal submission, and details/summary for evidence. Busy disables submit and announces status. Errors preserve the question and allow explicit manual retry. Clearing returns focus to the input. Results follow `watchOrder`, not timestamps. No-Key mode is fully usable and clearly labelled keyword retrieval. A separate recommendation class must coexist with playback-follow highlights. API settings remain the existing extension settings page.

## Do's and Don'ts

- Show unknown token usage as unknown. Debug state must not persist API keys, complete goals or transcripts.
- Use only validated local evidence times and cue references. Use fixed Bilibili search templates; never render model-supplied arbitrary URLs.
- Do not automatically call AI when tabs open, evidence expands or highlights change. Cached chapter displays must not request new chapters.
- Respect IME composition, native keyboard controls and reduced motion. Provide visible focus and text-labelled states; do not rely on pink or blue alone.
