"""Windows fused SDPA must preserve causal GQA and leave other routes alone."""

from types import SimpleNamespace

import pytest
import torch
from transformers.integrations.sdpa_attention import sdpa_attention_forward
from qwen_tts.core.models import sdpa


@pytest.mark.parametrize("query_length,key_length,causal,scaling", [
    (1, 8, None, None), (4, 4, None, .25), (4, 8, False, .5), (2, 8, True, None),
])
def test_expanded_attention_preserves_gqa(monkeypatch, query_length, key_length, causal, scaling):
    module = SimpleNamespace(num_key_value_groups=2, is_causal=True, training=False)
    torch.manual_seed(73)
    query = torch.randn(1, 4, query_length, 8)
    key, value = (torch.randn(1, 2, key_length, 8) for _ in range(2))
    expected, _ = sdpa_attention_forward(module, query, key, value, None,
                                         is_causal=causal, scaling=scaling)
    monkeypatch.setattr(sdpa, "_use_expanded_gqa", lambda *args: True)
    actual, weights = sdpa.qwen_sdpa_attention_forward(module, query, key, value, None,
                                                      is_causal=causal, scaling=scaling)
    torch.testing.assert_close(actual, expected)
    assert actual.shape == (1, query_length, 4, 8)
    assert weights is None


@pytest.mark.parametrize("device,training,groups,mask,kwargs,expected", [
    ("cuda", False, 2, None, {}, True),
    ("cpu", False, 2, None, {}, False),
    ("cuda", True, 2, None, {}, False),
    ("cuda", False, 1, None, {}, False),
    ("cuda", False, 2, object(), {}, False),
    ("cuda", False, 2, None, {"output_attentions": True}, False),
    ("cuda", False, 2, None, {"head_mask": object()}, False),
])
def test_windows_policy_scope(monkeypatch, device, training, groups, mask, kwargs, expected):
    monkeypatch.setattr(sdpa, "_WINDOWS_WITHOUT_FLASH", True)
    module = SimpleNamespace(training=training, num_key_value_groups=groups)
    query = SimpleNamespace(device=SimpleNamespace(type=device))
    assert sdpa._use_expanded_gqa(module, query, mask, kwargs) is expected
    monkeypatch.setattr(sdpa, "_WINDOWS_WITHOUT_FLASH", False)
    assert not sdpa._use_expanded_gqa(module, query, mask, kwargs)


def test_masked_route_keeps_transformers_handling(monkeypatch):
    module = SimpleNamespace(num_key_value_groups=2, is_causal=True, training=False)
    query, key, value = (torch.randn(1, heads, 3, 8) for heads in (4, 2, 2))
    mask = torch.tensor([[[[0., -float('inf'), -float('inf')],
                           [0., 0., -float('inf')], [0., 0., 0.]]]])
    expected, _ = sdpa_attention_forward(module, query, key, value, mask)
    calls = []
    def original(*args, **kwargs):
        calls.append(args[4])
        return sdpa_attention_forward(*args, **kwargs)
    monkeypatch.setattr(sdpa, "sdpa_attention_forward", original)
    actual, _ = sdpa.qwen_sdpa_attention_forward(module, query, key, value, mask)
    torch.testing.assert_close(actual, expected)
    assert len(calls) == 1 and calls[0] is mask
