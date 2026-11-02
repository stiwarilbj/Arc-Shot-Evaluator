export const COURT_MODEL = {
  file: "freeze-floor/models/court-keypoints.onnx",
  sha256: "225c308008d25edf243f0f246b70900c564529105480562456015a916338e621",
  bytes: 16 * 1024 * 1024,
  source:
    "https://huggingface.co/koppolusameer/yolo11n-basketball-court-keypoints",
  revision: "6cb899251439982067a81baa225b33f45f335981",
  slots: 48,
} as const;
export const PERSON_MODEL = {
  file: "jumper/models/person-detector.onnx",
  sha256: "ae0eb4ed805163adc419b3db5454b3dfcf8b3620148fc4e294b0a1e5cccc26d5",
  bytes: 16 * 1024 * 1024,
} as const;
// Automatic acceptance stays disabled until an independent real-photo benchmark passes.
export const AUTOMATIC_BENCHMARK = {
  status: "not-validated",
  supportedPhotos: 0,
  unsuitablePhotos: 0,
  automaticAcceptance: false,
} as const;
