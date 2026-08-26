from manim import *
import math
# ProofCanvas settings: 16:9, 854x480, 15fps, draft, preview=standard


class GeneratedScene(MovingCameraScene):
    def construct(self):
        # Shot 1: Native shape parity
        self.next_section("Native shape parity")
        self.camera.background_color = "#ffffff"
        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))
        pc_ellipse_parity_probe = Ellipse(width=2.22222219, height=1.33333331).set_fill("#ff0000", opacity=1.0).set_stroke("#ff0000", width=4.0)
        pc_ellipse_parity_probe.rotate(-17.0 * DEGREES, about_point=ORIGIN)
        pc_ellipse_parity_probe.shift([-5.33333325, 1.9259259, 0])
        pc_polygon_parity_probe = Polygon([-0.48, -0.3, 0], [-0.18, 0.48, 0], [0.46, 0.24, 0], [0.34, -0.42, 0], [-0.12, -0.48, 0], joint_type=LineJointType.BEVEL).stretch(2.28148145, 0, about_point=ORIGIN).stretch(1.74814812, 1, about_point=ORIGIN).set_fill("#00ff00", opacity=1.0).set_stroke("#00ff00", width=5.0)
        pc_polygon_parity_probe.rotate(12.0 * DEGREES, about_point=ORIGIN)
        pc_polygon_parity_probe.shift([-2.22222219, 1.9259259, 0])
        pc_dashed_line_parity_probe = DashedLine([-1.28888887, 0, 0], [1.28888887, 0, 0], dash_length=0.26666671, dashed_ratio=0.62068966, cap_style=CapStyleType.ROUND).set_stroke("#0000ff", width=8.0)
        pc_dashed_line_parity_probe.rotate(-7.0 * DEGREES, about_point=ORIGIN)
        pc_dashed_line_parity_probe.shift([1.03703702, 1.9259259, 0])
        pc_double_arrow_parity_probe = DoubleArrow([-1.28888887, 0, 0], [1.28888887, 0, 0], buff=0, max_tip_length_to_length_ratio=0.22, tip_shape_start=StealthTip, tip_shape_end=ArrowCircleFilledTip).set_cap_style(CapStyleType.SQUARE).set_color("#ff00ff").set_stroke("#ff00ff", width=5.0)
        pc_double_arrow_parity_probe.rotate(8.0 * DEGREES, about_point=ORIGIN)
        pc_double_arrow_parity_probe.shift([4.59259252, 1.9259259, 0])
        pc_freeform_path_parity_probe = VMobject(joint_type=LineJointType.ROUND, cap_style=CapStyleType.ROUND).start_new_path([-0.5, -0.24, 0]).add_cubic_bezier_curve_to([-0.4, 0.42, 0], [-0.28, 0.34, 0], [-0.08, 0.3, 0]).add_cubic_bezier_curve_to([0.1, 0.26, 0], [0.34, 0.46, 0], [0.5, -0.2, 0]).stretch(4.59259252, 0, about_point=ORIGIN).stretch(2.04444441, 1, about_point=ORIGIN).set_fill("#00ffff", opacity=0.0).set_stroke("#00ffff", width=7.0, opacity=1.0)
        pc_freeform_path_parity_probe.rotate(-4.0 * DEGREES, about_point=ORIGIN)
        pc_freeform_path_parity_probe.shift([0.0, -1.65925923, 0])
        self.add(pc_ellipse_parity_probe, pc_polygon_parity_probe, pc_dashed_line_parity_probe, pc_double_arrow_parity_probe, pc_freeform_path_parity_probe)
        self.play(Succession(Wait(8.0), group=Group(), run_time=8.0))
