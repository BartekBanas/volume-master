# Volume Master

## Language

**Native**:
A tab's unaltered audio level in Gain mode, corresponding to exactly 100% Volume.
Compression mode has no Native setting.
_Avoid_: default, normal, 1x

**Volume**:
A gain multiplier applied to a tab, where 100% is native and 2000% is the
ceiling. Percentages here are relative to the source, so they can exceed 100%.
_Avoid_: level, gain, boost

**Gain mode**:
The mode where the slider sets Volume directly. How the extension has always
worked, and still the default.
_Avoid_: manual mode, normal mode, classic mode

**Compression mode**:
The mode where the slider sets Target Volume and the extension adjusts gain
toward that RMS target. Intensity controls how strongly it adjusts. Chosen per
tab, off by default.
_Avoid_: auto mode, normalization, limiter

**Target Volume**:
The RMS audio level the extension aims for, measured as a percentage of
full-scale RMS. 100% corresponds to 0 dBFS RMS. Unlike Volume, it cannot exceed
100%.
_Avoid_: target gain, target level, loudness

**Intensity**:
How strongly the extension adjusts a tab's gain toward its Target Volume. Set
per tab with the knob beside the target slider.
_Avoid_: strength, amount, ratio, makeup

**Granular mode**:
The mode where a slider can only rest on preset stops instead of any value.
Global, off by default, and applies to both the Volume and Target Volume
sliders.
_Avoid_: stepped mode, snap mode, discrete mode

**Stop**:
One of the fixed values a slider snaps to in granular mode. Gain mode and
compression mode have separate lists of them.
_Avoid_: step, notch, preset, detent

**Limiter**:
The peak-catching stage at the end of the audio chain that stops loud gain from
clipping. Independent of both modes and controlled from the popup footer.
_Avoid_: clipper, compressor

**Capturable tab**:
A tab the extension is allowed to touch. Browser pages, the Web Store, and
other privileged URLs are not capturable.
_Avoid_: supported tab, valid tab
