"""Small cross-domain helpers for audiobook data integrity."""

from sqlalchemy.orm import Session

from ..database import AudiobookSentence, Generation


def profile_has_audiobook_references(profile_id: str, db: Session) -> bool:
    """Whether generated audiobook sentences still depend on a voice."""
    return (
        db.query(AudiobookSentence.id)
        .join(Generation, AudiobookSentence.generation_id == Generation.id)
        .filter(Generation.profile_id == profile_id)
        .first()
        is not None
    )
