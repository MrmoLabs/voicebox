"""Keep Windows CUDA decode on fused SDPA when Flash SDPA is unavailable."""

import sys

import torch
from transformers.integrations.sdpa_attention import repeat_kv, sdpa_attention_forward


_WINDOWS_WITHOUT_FLASH = (
    sys.platform == "win32" and not torch.backends.cuda.is_flash_attention_available()
)


def _use_expanded_gqa(module, query, attention_mask, kwargs):
    return (_WINDOWS_WITHOUT_FLASH and query.device.type == "cuda" and not module.training
            and attention_mask is None and getattr(module, "num_key_value_groups", 1) > 1
            and not kwargs.get("output_attentions", False) and kwargs.get("head_mask") is None)


def qwen_sdpa_attention_forward(module, query, key, value, attention_mask,
                                dropout=0.0, scaling=None, is_causal=None, **kwargs):
    # Transformers enables native GQA on CUDA even when this Torch build lacks
    # Flash SDPA. Unequal head counts then exclude memory-efficient SDPA and
    # select math. Explicit repetition preserves GQA semantics while allowing
    # the existing efficient kernel, without changing global kernel priorities.
    if _use_expanded_gqa(module, query, attention_mask, kwargs):
        groups = module.num_key_value_groups
        key, value = repeat_kv(key, groups), repeat_kv(value, groups)
        if is_causal is None:
            is_causal = query.shape[2] > 1 and getattr(module, "is_causal", True)
        output = torch.nn.functional.scaled_dot_product_attention(
            query, key, value, attn_mask=None, dropout_p=dropout,
            scale=scaling, is_causal=is_causal,
        )
        return output.transpose(1, 2).contiguous(), None
    return sdpa_attention_forward(module, query, key, value, attention_mask,
                                  dropout=dropout, scaling=scaling, is_causal=is_causal, **kwargs)
