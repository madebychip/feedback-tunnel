# v0.2.0: a redesigned review overlay

![Setting your name and colour, previewed as a real comment](https://raw.githubusercontent.com/madebychip/feedback-tunnel/v0.2.0/docs/welcome.webp)

The overlay reviewers see has been rebuilt from the ground up: a calm dark layer that stays out of the prototype's way, on light and dark sites alike.

## What's new for reviewers

- **Set up inside a real comment.** The first time someone comments, they type their name and pick from 10 colours inside a live preview of a comment, so they learn how it works before they start.
- **A smaller dock.** Two icons, with labels and keyboard shortcuts (**C** to comment, **N** for the list) in tooltips. While commenting, the dock shows who you are and how to leave (**Esc**).
- **Writing stays next to the thing.** The outline and pin take your colour. Send has its own row, so long comments never run under it. On phones, the box stays by its pin and rides above the keyboard.
- **Pins that say which, and colour that says who.** Numbers sit inside the pin, and hovering shows the name and first line. Resolved pins leave the page instead of piling up.
- **A clearer comment card.** Who said it, what they said, then where and on what screen.
- **Open and Resolved tabs** in the comments panel, with counts always visible.
- **"Comments", not "notes"**, the word people already know from Figma and Google Docs.

## What's new for you (the host)

- The first comment brings a hint, in your view only, that comments are saved to `FEEDBACK.md`, with **Copy prompt** (the instruction for your coding agent) and **Open file** (opens it in one click). The terminal prints the same tip once per session.
- Reviewers never see the file name or the button. Opening the file only works from your own machine.

## Lighter and faster

- The overlay ships compressed (about 20 KB) and a reload costs a "not modified" reply instead of a re-download.
- It rests when nobody is interacting, so it uses about 30 times fewer layout reads while idle.
- It checks for new comments every 2 seconds while someone is reviewing, easing to every 10 seconds after a minute without interaction, which saves battery on phones.

## Upgrading

```bash
npx feedback-tunnel@latest 3000
```

No config changes. Existing `FEEDBACK.md` files keep working.
