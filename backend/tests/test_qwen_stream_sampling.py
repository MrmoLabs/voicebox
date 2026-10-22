"""Exercise the real streaming loop without downloading model weights."""

from types import SimpleNamespace

import numpy as np
import pytest
import torch

from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSForConditionalGeneration
from qwen_tts.inference.qwen3_tts_model import Qwen3TTSModel


EOS = 1029


def fake_model(*, terminate=True, frames=2, sequential=False):
    calls = []
    vocab_size = 2048 if sequential else 1030

    def forward(**kwargs):
        calls.append(kwargs)
        logits = torch.full((1, 1, vocab_size), -100.0)
        logits[0, 0, 0] = 2.0
        logits[0, 0, 4] = 1.6
        # Greedy decoding must suppress special codec tokens too.
        logits[0, 0, 1000] = 100.0
        if sequential:
            logits.fill_(-100.0)
            logits[0, 0, len(calls) - 1] = 100.0
        if terminate and len(calls) >= frames + 1:
            logits[0, 0, EOS] = 200.0
        token = kwargs.get('input_ids', torch.tensor([[0]]))[0, 0]
        return SimpleNamespace(logits=logits, past_key_values=None, past_hidden=None,
            generation_step=len(calls), hidden_states=(None, torch.tensor([[token, 4]])))

    def decode(items):
        codes = items[0]['audio_codes']
        return [codes[:, 0].numpy().repeat(2).astype(np.float32)], 24000

    return SimpleNamespace(
        config=SimpleNamespace(talker_config=SimpleNamespace(codec_eos_token_id=EOS, vocab_size=vocab_size)),
        talker=SimpleNamespace(forward=forward, device='cpu'),
        speech_tokenizer=SimpleNamespace(decode=decode, get_decode_upsample_rate=lambda: 2),
        _build_talker_inputs=lambda **kwargs: (None, None, None, None),
    ), calls


def stream(model, emit_every_frames=1, **kwargs):
    return Qwen3TTSForConditionalGeneration.stream_generate_pcm(
        model, input_ids=[torch.tensor([[1]])], do_sample=False,
        emit_every_frames=emit_every_frames, use_optimized_decode=False, **kwargs)


@pytest.mark.parametrize('emit_every_frames', [1, 8])
def test_repetition_control_uses_only_first_codebook_and_stops_before_eos_forward(emit_every_frames):
    model, calls = fake_model()
    chunks = list(stream(model, repetition_penalty=2.0, max_frames=2, emit_every_frames=emit_every_frames))
    # Token 0 repeats without the penalty. Token 4 is present in the secondary
    # codebook from frame one and must remain available in the first codebook.
    assert [call['input_ids'].item() for call in calls[1:]] == [0, 4]
    np.testing.assert_array_equal(np.concatenate([chunk for chunk, _ in chunks]), [0, 0, 4, 4])
    assert len(calls) == 3  # Prefill plus two frames, never an EOS codec frame.


def test_frame_budget_failure_cannot_appear_as_successful_end_of_stream():
    model, calls = fake_model(terminate=False)
    generator = stream(model, max_frames=2)
    next(generator)
    next(generator)
    with pytest.raises(RuntimeError, match='frame limit without an end token'):
        next(generator)
    assert len(calls) == 3


@pytest.mark.parametrize('max_frames', [0, -1])
def test_invalid_budget_rejected_before_inference(max_frames):
    model, calls = fake_model()
    with pytest.raises(ValueError, match='max_frames'):
        list(stream(model, max_frames=max_frames))
    assert not calls


@pytest.mark.parametrize('frames,expected_sizes', [
    (5, [10]), (8, [16]), (9, [16, 2]),
    (24, [16, 32]), (34, [16, 32, 20]), (104, [16] + [32] * 6),
])
def test_steady_cadence_preserves_first_packet_and_flushes_every_frame_once(frames, expected_sizes):
    model, calls = fake_model(frames=frames, sequential=True)
    chunks = list(stream(model, emit_every_frames=8, steady_emit_every_frames=16,
                         max_frames=frames, repetition_penalty=1.0))
    assert [len(chunk) for chunk, _ in chunks] == expected_sizes
    np.testing.assert_array_equal(np.concatenate([chunk for chunk, _ in chunks]),
                                  np.arange(frames).repeat(2))
    assert len(calls) == frames + 1


@pytest.mark.parametrize('options', [
    {'emit_every_frames': 0}, {'emit_every_frames': True},
    {'steady_emit_every_frames': 0}, {'steady_emit_every_frames': -1},
    {'steady_emit_every_frames': 1.5}, {'steady_emit_every_frames': True},
    {'steady_emit_every_frames': 81}, {'emit_every_frames': 81},
])
def test_invalid_cadence_cannot_decode_or_truncate_a_window(options):
    model, calls = fake_model()
    with pytest.raises(ValueError, match='emit_every_frames'):
        list(stream(model, **options))
    assert not calls


def test_closing_after_first_packet_does_not_generate_the_larger_next_packet():
    model, calls = fake_model(frames=34, sequential=True)
    generator = stream(model, emit_every_frames=8, steady_emit_every_frames=16, max_frames=34)
    assert len(next(generator)[0]) == 16
    generator.close()
    assert len(calls) == 9  # Prefill plus eight frames; no speculative next decode.


@pytest.mark.parametrize('frames', [5, 9, 34, 104])
@pytest.mark.parametrize('optimized', [False, True])
def test_steady_packets_exclude_reference_prefix_including_the_final_flush(frames, optimized):
    model, _ = fake_model(frames=frames, sequential=True)
    if optimized:
        model.speech_tokenizer.decode_streaming = lambda codes, **kw: model.speech_tokenizer.decode([{'audio_codes': codes}])
    prompt = {'icl_mode': [True], 'ref_code': [torch.full((90, 2), -99)]}
    chunks = list(Qwen3TTSForConditionalGeneration.stream_generate_pcm(
        model, input_ids=[torch.tensor([[1]])], voice_clone_prompt=prompt,
        do_sample=False, repetition_penalty=1.0, emit_every_frames=8,
        steady_emit_every_frames=16, use_optimized_decode=optimized, max_frames=frames))
    np.testing.assert_array_equal(np.concatenate([chunk for chunk, _ in chunks]), np.arange(frames).repeat(2))


def test_default_cadence_stays_fixed_for_existing_callers():
    model, _ = fake_model(frames=34, sequential=True)
    chunks = list(stream(model, emit_every_frames=8, max_frames=34))
    assert [len(chunk) for chunk, _ in chunks] == [16, 16, 16, 16, 4]


@pytest.mark.parametrize('options,expected_frames,expected_penalty', [
    ({}, 2048, 1.05),
    ({'max_new_tokens': 24, 'repetition_penalty': 1.2}, 24, 1.2),
    ({'max_frames': 12, 'max_new_tokens': 24}, 12, 1.05),
])
def test_wrapper_preserves_generation_defaults_and_caller_limits(options, expected_frames, expected_penalty):
    captured = []

    def generate(**kwargs):
        captured.append(kwargs)
        yield np.zeros(2), 24000

    wrapper = object.__new__(Qwen3TTSModel)
    wrapper.model = SimpleNamespace(tts_model_type='base', stream_generate_pcm=generate)
    wrapper.generate_defaults = {}
    wrapper._validate_languages = lambda languages: None
    wrapper._build_assistant_text = lambda text: text
    wrapper._tokenize_texts = lambda texts: [torch.tensor([[1]])]
    list(wrapper.stream_generate_voice_clone('test', voice_clone_prompt={}, **options))
    assert captured[0]['repetition_penalty'] == expected_penalty
    assert captured[0]['max_frames'] == expected_frames


def test_wrapper_forwards_explicit_steady_cadence_without_changing_sampling():
    captured = []
    wrapper = object.__new__(Qwen3TTSModel)
    wrapper.model = SimpleNamespace(tts_model_type='base', stream_generate_pcm=lambda **kw: captured.append(kw) or iter(()))
    wrapper.generate_defaults = {}
    wrapper._validate_languages = lambda languages: None
    wrapper._build_assistant_text = lambda text: text
    wrapper._tokenize_texts = lambda texts: [torch.tensor([[1]])]
    list(wrapper.stream_generate_voice_clone('test', voice_clone_prompt={},
        emit_every_frames=8, steady_emit_every_frames=16, use_optimized_decode=False))
    assert captured[0]['emit_every_frames'] == 8
    assert captured[0]['steady_emit_every_frames'] == 16
    assert captured[0]['decode_window_frames'] == 80
    assert captured[0]['use_optimized_decode'] is False
    assert captured[0]['repetition_penalty'] == 1.05
