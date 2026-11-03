# TensorRT-LLM 1.2.1 release image with the NVML pointer fix (upstream issue 18816).
FROM nvcr.io/nvidia/tensorrt-llm/release:1.2.1@sha256:33cd085b772947bd22b7273886539331420404e5d2a4a039945241945ff927b9

ARG UTILS=/usr/local/lib/python3.12/dist-packages/tensorrt_llm/_utils.py

RUN echo "0619e389b2d6941abd369d7466b5c0f254ad23a4fa040d0e8baf68bd0e33661c  ${UTILS}" | sha256sum --check - \
 && sed -i \
      -e 's/^import copy$/import copy\nfrom ctypes import byref/' \
      -e 's/pynvml\.nvmlSystemGetConfComputeSettings(cc_settings)/pynvml.nvmlSystemGetConfComputeSettings(byref(cc_settings))/' \
      "${UTILS}" \
 && echo "85570e359efb2e36263e032a6ef7a4c55705c621cbe8143f880a21a53856207e  ${UTILS}" | sha256sum --check -
