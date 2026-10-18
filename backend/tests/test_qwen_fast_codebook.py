"""Ensure the direct codebook loop preserves the ordinary generation contract."""
import pytest
import torch

from qwen_tts.core.models.configuration_qwen3_tts import (
    Qwen3TTSTalkerConfig, Qwen3TTSTalkerCodePredictorConfig,
)
from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSTalkerCodePredictorModelForConditionalGeneration


@pytest.mark.parametrize('sample,top_k,top_p', [(False, 0, 1.0), (True, 7, 1.0), (True, 7, 0.8)])
def test_direct_codebooks_match_generation_mixin(sample, top_k, top_p):
    torch.manual_seed(13)
    config = Qwen3TTSTalkerCodePredictorConfig(
        vocab_size=32, hidden_size=16, intermediate_size=32, num_hidden_layers=1,
        num_attention_heads=2, num_key_value_heads=1, head_dim=8, num_code_groups=4,
        pad_token_id=0, bos_token_id=1, eos_token_id=None,
    )
    model = Qwen3TTSTalkerCodePredictorModelForConditionalGeneration(config, Qwen3TTSTalkerConfig(hidden_size=24)).eval()
    inputs = torch.randn(2, 2, 24)
    with torch.inference_mode():
        torch.manual_seed(42)
        ordinary = model.generate(inputs_embeds=inputs, max_new_tokens=3, do_sample=sample,
            temperature=.9 if sample else None, top_k=top_k if sample else None, top_p=top_p if sample else None)
        torch.manual_seed(42)
        direct = model.generate_fast(inputs, num_codebooks=3, do_sample=sample,
            temperature=.9, top_k=top_k, top_p=top_p)
    torch.testing.assert_close(direct, ordinary)
