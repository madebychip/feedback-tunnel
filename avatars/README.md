# Avatar images

Each animal in `avatars.json` shows as a coloured circle with two letters until you add a picture for it.

To add one, save a file here named after the animal's `id`:

```
avatars/axolotl.png
avatars/capybara.png
avatars/otter.webp      png, webp, svg and jpg all work
```

The ids are axolotl, capybara, dolphin, fox, frog, koala, lemur, narwhal, otter, owl, panda, penguin, quokka, turtle, whale and yak.

## Sizing

- Square, 256×256 px. PNG or WebP. SVG is fine too.
- The image is cropped to a circle, so keep the animal's face inside the middle 80%.
- Avatars appear as small as 24 px inside a pin, so bold shapes and a clear face read better than fine detail.
- Fill the background with the animal's colour from `avatars.json`, or leave it transparent. The colour shows through either way.

## Changing the set

Edit `avatars.json` to rename animals, change colours or add more. Each entry needs an `id` (lowercase letters, numbers and dashes), a `name` and a `color` as a hex value. Light colours get dark text on top automatically.

New images show up on the next page load. Changes to `avatars.json` itself need a restart.
