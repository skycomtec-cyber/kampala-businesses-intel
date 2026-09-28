# Image credits

Third-party imagery in this folder, and how the derivatives here were made.

## `kampala-hero.webp`, `kampala-hero-sm.webp`

The landing hero band on `index.html`.

- **Original:** [View of Kampala city 1](https://commons.wikimedia.org/wiki/File:View_of_Kampala_city_1.jpg)
- **Author:** Dr. S-mon ("own work")
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Source:** Wikimedia Commons, 3845×2050

Credit for the photograph is rendered in the page itself as well as here, because
CC BY 4.0 asks for credit a reader can actually reach rather than only a note in a
repository. If this image is ever replaced, that line in `index.html` is a licence
obligation, not decoration — and the replacement's licence is what decides it. CC
BY-SA in particular was avoided deliberately: the graded derivative below is an
adaptation, and share-alike would carry that obligation into a repository that
carries no licence of its own.

### Derivation

Both files come from the one original. They are not two photographs, and they are
kept at matching geometry on purpose: `theme.css` positions the band with
`background-position: center 38%` and crops 5rem off the top, and that geometry
was tuned against a 1.808 frame. Holding the frame identical is what keeps the
existing positioning meaningful across a swap.

**The photograph is left in colour.** An earlier pass reproduced the previous
hero's treatment instead — near-grayscale with a slight cool lean — on the
reasoning that matching the old treatment was the safer default. That was
reconsidered and is deliberately not done here: the band is a Kampala
cityscape, and a Kampala cityscape flattened to near-gray stops reading as
Kampala. Measured saturation went from 2.5 to 14.3 mean, with a green cast
(green 20 above blue) consistent with the hills the city sits on. The earlier
grading chain, if it is ever wanted again, is recorded in the commit history of
this file rather than here.

```sh
# Desktop 1920x1062. Crop first, so the frame lands on 1.808 before scaling.
ffmpeg -i src.jpg -vf "crop=3706:2050:69:0,scale=1920:1062:flags=lanczos,\
gblur=sigma=1.2" -c:v libwebp -quality 32 -compression_level 6 kampala-hero.webp

# Mobile 800x442, lighter blur because there are fewer pixels to spare.
ffmpeg -i src.jpg -vf "crop=3706:2050:69:0,scale=800:442:flags=lanczos,\
gblur=sigma=0.8" -c:v libwebp -quality 32 -compression_level 6 kampala-hero-sm.webp
```

Two things in that chain are load-bearing and were not obvious:

- **`gblur` is what pays for the quality setting.** This is a dense, high-frequency
  cityscape, and its size curve is nearly flat: quality 70 landed at 246 KB and
  quality 30 still landed at 137 KB in grayscale, because the bits are going into
  foliage, windows and roofline detail. Reaching the previous 68 KB purely by
  dropping quality would have meant sitting near quality 5. Softening first and
  then encoding at quality 32 costs about the same bytes with none of the
  blocking. The band is partly covered by an opaque paper gradient and carries no
  text, so detail there is largely unspent. Drop the blur and re-measure before
  assuming the budget moved.
- **Colour is not free.** The same blur-plus-quality recipe that held 68 KB in
  grayscale needs quality 32 instead of 40 to hold the same weight in colour,
  landing at 77 KB. If the band has to come back to 68 KB, that is the
  constraint to work against, not the photograph's fault.

The photograph is brighter than the one it replaced (mean luma 124 against 103).
That was left alone rather than corrected, because the exposure is the
photograph's and not a defect in it. If the band ends up competing with the
palette, adjust exposure deliberately rather than reaching for saturation.
