# Volume Master

## Language

**Bypassed**:
A per-tab state meaning Volume Master is not capturing that tab's audio. A tab
is captured exactly when Bypassed is off, even at 100% Volume. Default on.
Independent of Gain mode and Compression mode. Shown and toggled by the header
chip; on is the filled chip plus a cool shade over the popup. Moving the slider
or knob, or switching Compression mode, turns it off. Reset restores defaults
without changing it. A Bypassed tab keeps its last values and re-applies them
when Bypassed turns off.
_Avoid_: Bypass, Idle, Passthrough, Native (for this state)

**Native**:
A tab's unaltered audio level in Gain mode, corresponding to exactly 100% Volume.
Compression mode has no Native setting. Native is not Bypassed: a tab can be at
100% Volume with Bypassed off and still be captured.
_Avoid_: default, normal, 1x, Bypass

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
The RMS audio level the extension aims for. In dB, 0 is full scale and the
default is −15 dBFS. In percent, the number is the slider position: 0 mute, 50
the default, 100 full scale. Percent is not linear RMS; 50% is −15 dBFS, not
−6. Ranges from mute (slider at 0) to 0 dBFS (slider at max). Unlike Volume, it
cannot exceed 0 dBFS / 100%.
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
