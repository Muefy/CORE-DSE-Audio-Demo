# CORE-DSE: Coarse Extraction and Refinement with Time-Frequency Gated Cross-Attention for Directional Speech Extraction

**[Listen to the Audio Demo](https://muefy.github.io/CORE-DSE-Audio-Demo/)**

This repository accompanies the CORE-DSE paper with audio comparisons, spectrograms, and visualizations of the speech extraction process.

## Abstract

Direction of arrival (DOA) is a natural cue for multichannel directional speech extraction (DSE), but its few global geometric variables are poorly matched to dense time-frequency acoustic representations, limiting the performance of existing DSE methods. We propose CORE-DSE, a coarse extraction and refinement framework that addresses this representation-granularity mismatch. Specifically, the Coarse Extractor (CE) combines Time-Frequency Gated Cross-Attention (TF-GCA), which models the relevance of the target direction to individual time-frequency units, with a Local Gated Mixer (LGM) to produce direction-aware spectral and spatial representations. A Fine Enhancer (FE) then suppresses residual interference and restores target speech details. Experiments show that CORE-DSE consistently outperforms physics-informed and generic DOA conditioning baselines with only marginal computational overhead. Effective directional fusion yields greater gains than increasing model capacity, and CE consistently improves performance across different enhancement backbones.

## Audio Comparisons

| Section | Samples and comparisons |
| --- | --- |
| [Real Recordings](https://muefy.github.io/CORE-DSE-Audio-Demo/#real-recordings) | Three simultaneous speakers in a large classroom, including two speakers approximately 5 m from the array. Each speaker is presented with close-talking speech, a 50 ms far-field reference, SpatialNet-Concat (without CE), and SpatialNet-CORE (with CE). |
| [Simulated (Easy)](https://muefy.github.io/CORE-DSE-Audio-Demo/#easy-samples) | Three samples from the 2D-spatialized dataset, comparing JNF-SSF, JNF-Concat, JNF-SoundCompass-Fusion, and JNF-CORE alongside the unprocessed mixture and clean reference. |
| [Simulated (Hard)](https://muefy.github.io/CORE-DSE-Audio-Demo/#hard-samples) | Three samples from the 3D-spatialized dataset with 2, 3, and 5 speakers, comparing SpatialNet-Concat (without CE) and SpatialNet-CORE (with CE) alongside the unprocessed mixture and clean reference. |

All models used for the real recording were trained on the simulated datasets described in the paper, without fine-tuning on real recordings. The far-field reference is obtained by projecting the close-talking speech onto the reference microphone using a 50 ms FIR filter; it serves as the extraction target. Data collection is ongoing, and further details will be presented in future work.

The simulated samples report PESQ, ESTOI, and SI-SDR for the enhanced outputs, with DNSMOS scores available through **Show DNSMOS**. The real recording reports **P808_MOS** for each enhanced output. Spectrograms can be clicked to seek within the corresponding audio track.
