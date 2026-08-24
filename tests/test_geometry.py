from backend.analysis.geometry import joint_angle, line_angle_degrees


def test_joint_angle_right_angle() -> None:
    assert joint_angle((0, 1), (0, 0), (1, 0)) == 90.0


def test_entry_angle_is_acute_for_leftward_descent() -> None:
    assert round(line_angle_degrees((2, -2), (1, -1))) == 45
