"""
moisture-service model package.

Public API
----------
model_registry  : Singleton ModelRegistry — load/predict interface.
MoisturePredictor : The nn.Module (useful for training scripts).
ModelConfig     : Hyperparameter dataclass.
ModelOutput     : NamedTuple returned by MoisturePredictor.forward().
PredictionResult: Dataclass returned by ModelRegistry.predict().
"""

from src.model.config import ModelConfig
from src.model.predictor import ModelOutput, MoisturePredictor
from src.model.registry import PredictionResult, model_registry

__all__ = [
    "ModelConfig",
    "ModelOutput",
    "MoisturePredictor",
    "PredictionResult",
    "model_registry",
]
