import asyncio

from backend.services import refinement
from backend.services.refinement import RefinementFlags, build_refinement_prompt


def test_selected_language_is_pinned_in_refinement_prompt():
    prompt = build_refinement_prompt(RefinementFlags(), language="zh")

    assert "Chinese (zh)" in prompt
    assert "Do not translate it or default to English" in prompt


def test_auto_detected_language_does_not_add_a_language_constraint():
    prompt = build_refinement_prompt(RefinementFlags(), language=None)

    assert "transcript language is" not in prompt


def test_non_english_refinement_does_not_send_english_examples(monkeypatch):
    class FakeBackend:
        model_size = "0.6B"

        async def generate(self, **kwargs):
            assert kwargs["examples"] is None
            assert "Chinese (zh)" in kwargs["system"]
            return "你好，世界。"

    monkeypatch.setattr(refinement.llm_service, "get_llm_model", lambda: FakeBackend())

    text, size = asyncio.run(
        refinement.refine_transcript(
            "你好世界",
            RefinementFlags(),
            language="zh",
        )
    )

    assert text == "你好，世界。"
    assert size == "0.6B"
