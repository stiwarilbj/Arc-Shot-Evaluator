from backend.analysis.vision_models import BasketballVisionModels


class RecordingPredictor:
    def __init__(self) -> None:
        self.kwargs: dict | None = None

    def predict(self, frames, **kwargs):
        self.kwargs = kwargs
        return []


def test_analysis_depth_selects_inference_resolution() -> None:
    model = BasketballVisionModels.__new__(BasketballVisionModels)
    model.device = "cpu"
    model.detector = RecordingPredictor()
    model.pose = RecordingPredictor()

    expected_sizes = {
        "fast": (704, 576),
        "normal": (960, 768),
        "deep": (1280, 960),
    }
    for mode, (detector_size, pose_size) in expected_sizes.items():
        model.infer_detector([], deep=mode == "deep", fast=mode == "fast")
        model.infer_pose([], deep=mode == "deep", fast=mode == "fast")

        assert model.detector.kwargs["imgsz"] == detector_size
        assert model.pose.kwargs["imgsz"] == pose_size
