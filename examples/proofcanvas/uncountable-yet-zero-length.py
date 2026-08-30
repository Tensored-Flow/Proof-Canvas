from manim import *
import math
# ProofCanvas settings: 16:9, 1280x720, 30fps, 720p, preview=standard

def proofcanvas_cubic_bezier(x, x1, y1, x2, y2):
    x = min(1.0, max(0.0, x))
    if x == 0.0 or x == 1.0:
        return x
    lower = 0.0
    upper = 1.0
    for iteration in range(32):
        candidate = (lower + upper) / 2.0
        inverse = 1.0 - candidate
        value = 3.0 * inverse * inverse * candidate * x1 + 3.0 * inverse * candidate * candidate * x2 + candidate * candidate * candidate
        if value < x:
            lower = candidate
        else:
            upper = candidate
    candidate = (lower + upper) / 2.0
    inverse = 1.0 - candidate
    return 3.0 * inverse * inverse * candidate * y1 + 3.0 * inverse * candidate * candidate * y2 + candidate * candidate * candidate


class GeneratedScene(MovingCameraScene):
    def construct(self):
        # Shot 1: The construction
        self.next_section("The construction")
        self.camera.background_color = "#f3eedf"
        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))
        pc_uncountable_yet_zero_length = Text("Uncountable, Yet Zero Length", font_size=38.0).set_color("#252722")
        pc_uncountable_yet_zero_length.scale(min(9.48148133 / max(pc_uncountable_yet_zero_length.width, 0.001), 0.77037036 / max(pc_uncountable_yet_zero_length.height, 0.001)))
        pc_uncountable_yet_zero_length.shift([-1.77777775, 2.93333329, 0])
        pc_ref_533feefd = pc_uncountable_yet_zero_length.copy()
        pc_a_quiet_paradox = Text("A quiet paradox in thirds", font_size=19.0).set_color("#4f534c")
        pc_a_quiet_paradox.scale(min(5.92592583 / max(pc_a_quiet_paradox.width, 0.001), 0.44444444 / max(pc_a_quiet_paradox.height, 0.001)))
        pc_a_quiet_paradox.shift([-3.49629624, 2.28148145, 0])
        pc_ref_7995a2a9 = pc_a_quiet_paradox.copy()
        pc_original_interval = RoundedRectangle(corner_radius=min(0.01481481, 8.44444431 / 2.0, 0.2074074 / 2.0), width=8.44444431, height=0.2074074).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_original_interval.shift([0.0, 0.96296295, 0])
        pc_ref_9e40e534 = pc_original_interval.copy()
        pc_first_left_interval = RoundedRectangle(corner_radius=min(0.01481481, 2.81481477 / 2.0, 0.2074074 / 2.0), width=2.81481477, height=0.2074074).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_first_left_interval.shift([-2.81481477, 0.17777777, 0])
        pc_ref_e154d848 = pc_first_left_interval.copy()
        pc_first_right_interval = RoundedRectangle(corner_radius=min(0.01481481, 2.81481477 / 2.0, 0.2074074 / 2.0), width=2.81481477, height=0.2074074).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_first_right_interval.shift([2.81481477, 0.17777777, 0])
        pc_ref_8ab03d9b = pc_first_right_interval.copy()
        pc_first_removal = RoundedRectangle(corner_radius=min(0.01481481, 2.81481477 / 2.0, 0.2074074 / 2.0), width=2.81481477, height=0.2074074).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.35)
        pc_first_removal.shift([0.0, 0.17777777, 0])
        pc_ref_a1bebae4 = pc_first_removal.copy()
        pc_second_generation_i = RoundedRectangle(corner_radius=min(0.01481481, 0.9185185 / 2.0, 0.17777777 / 2.0), width=0.9185185, height=0.17777777).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_second_generation_i.shift([-3.7629629, -0.6074074, 0])
        pc_ref_46df2fb2 = pc_second_generation_i.copy()
        pc_second_generation_ii = RoundedRectangle(corner_radius=min(0.01481481, 0.9185185 / 2.0, 0.17777777 / 2.0), width=0.9185185, height=0.17777777).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_second_generation_ii.shift([-1.86666664, -0.6074074, 0])
        pc_ref_20dcb549 = pc_second_generation_ii.copy()
        pc_second_generation_iii = RoundedRectangle(corner_radius=min(0.01481481, 0.9185185 / 2.0, 0.17777777 / 2.0), width=0.9185185, height=0.17777777).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_second_generation_iii.shift([1.86666664, -0.6074074, 0])
        pc_ref_516af869 = pc_second_generation_iii.copy()
        pc_second_generation_iv = RoundedRectangle(corner_radius=min(0.01481481, 0.9185185 / 2.0, 0.17777777 / 2.0), width=0.9185185, height=0.17777777).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_second_generation_iv.shift([3.7629629, -0.6074074, 0])
        pc_ref_776d72d2 = pc_second_generation_iv.copy()
        pc_second_removal = RoundedRectangle(corner_radius=min(0.01481481, 0.94814813 / 2.0, 0.17777777 / 2.0), width=0.94814813, height=0.17777777).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.3)
        pc_second_removal.shift([-2.81481477, -0.6074074, 0])
        pc_ref_addb316e = pc_second_removal.copy()
        pc_recursive_note = Text("remove the open middle third\n— then repeat", font_size=17.0).set_color("#4f534c")
        pc_recursive_note.scale(min(3.25925921 / max(pc_recursive_note.width, 0.001), 0.77037036 / max(pc_recursive_note.height, 0.001)))
        pc_recursive_note.shift([4.88888881, 1.70370368, 0])
        pc_ref_43340a46 = pc_recursive_note.copy()
        pc_third_generation_1 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_1.shift([-4.07407401, -1.2148148, 0])
        pc_ref_a9bfcdfe = pc_third_generation_1.copy()
        pc_third_removal_1 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32)
        pc_third_removal_1.shift([-3.7629629, -1.2148148, 0])
        pc_ref_c6f19501 = pc_third_removal_1.copy()
        pc_third_generation_2 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_2.shift([-3.4518518, -1.2148148, 0])
        pc_ref_eea547fd = pc_third_generation_2.copy()
        pc_third_generation_3 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_3.shift([-2.17777774, -1.2148148, 0])
        pc_ref_cd151d5d = pc_third_generation_3.copy()
        pc_third_removal_2 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32)
        pc_third_removal_2.shift([-1.86666664, -1.2148148, 0])
        pc_ref_ecf40f6a = pc_third_removal_2.copy()
        pc_third_generation_4 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_4.shift([-1.55555553, -1.2148148, 0])
        pc_ref_80525346 = pc_third_generation_4.copy()
        pc_third_generation_5 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_5.shift([1.55555553, -1.2148148, 0])
        pc_ref_78c0c13c = pc_third_generation_5.copy()
        pc_third_removal_3 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32)
        pc_third_removal_3.shift([1.86666664, -1.2148148, 0])
        pc_ref_12f689d3 = pc_third_removal_3.copy()
        pc_third_generation_6 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_6.shift([2.17777774, -1.2148148, 0])
        pc_ref_3db174ef = pc_third_generation_6.copy()
        pc_third_generation_7 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_7.shift([3.4518518, -1.2148148, 0])
        pc_ref_6112badb = pc_third_generation_7.copy()
        pc_third_removal_4 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32)
        pc_third_removal_4.shift([3.7629629, -1.2148148, 0])
        pc_ref_38f9043c = pc_third_removal_4.copy()
        pc_third_generation_8 = RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_third_generation_8.shift([4.07407401, -1.2148148, 0])
        pc_ref_b52704f0 = pc_third_generation_8.copy()
        pc_cantor_interval_diagram = Group(pc_original_interval, pc_first_left_interval, pc_first_right_interval, pc_first_removal, pc_second_generation_i, pc_second_generation_ii, pc_second_generation_iii, pc_second_generation_iv, pc_second_removal, pc_recursive_note, pc_third_generation_1, pc_third_removal_1, pc_third_generation_2, pc_third_generation_3, pc_third_removal_2, pc_third_generation_4, pc_third_generation_5, pc_third_removal_3, pc_third_generation_6, pc_third_generation_7, pc_third_removal_4, pc_third_generation_8)
        pc_length_after_n_stages = MathTex("L_n = (2/3)^n", font_size=31.0).set_color("#252722")
        pc_length_after_n_stages.scale(min(4.88888881 / max(pc_length_after_n_stages.width, 0.001), 0.62222221 / max(pc_length_after_n_stages.height, 0.001)))
        pc_length_after_n_stages.shift([-3.25925921, -1.88148145, 0])
        pc_ref_40bcd348 = pc_length_after_n_stages.copy()
        pc_limit_of_surviving_length = MathTex("\\lim_{n\\to\\infty} L_n = 0", font_size=26.0).set_color("#315866")
        pc_limit_of_surviving_length.scale(min(5.55555547 / max(pc_limit_of_surviving_length.width, 0.001), 0.56296295 / max(pc_limit_of_surviving_length.height, 0.001)))
        pc_limit_of_surviving_length.shift([-2.90370366, -2.59259255, 0])
        pc_ref_a53c3c29 = pc_limit_of_surviving_length.copy()
        pc_surviving_length_equation = VGroup(pc_length_after_n_stages, pc_limit_of_surviving_length)
        pc_measure_note = Text("Length vanishes.\nCardinality does not.", font_size=18.0).set_color("#4f534c")
        pc_measure_note.scale(min(2.81481477 / max(pc_measure_note.width, 0.001), 1.06666665 / max(pc_measure_note.height, 0.001)))
        pc_measure_note.shift([4.29629623, -1.9259259, 0])
        pc_ref_2b60b10e = pc_measure_note.copy()
        # Animation component 1: 0.0s to 1.5s
        self.play(AnimationGroup(Write(pc_uncountable_yet_zero_length, run_time=1.2, rate_func=rate_functions.ease_out_quart), Succession(Wait(0.7), FadeIn(pc_a_quiet_paradox, run_time=0.8, rate_func=rate_functions.ease_out_quart), group=Group(), run_time=1.5), group=Group(), lag_ratio=0, run_time=1.5))
        # Animation component 2: 1.8s to 3.0s
        self.play(Succession(Wait(0.3), group=Group(), run_time=0.3))
        self.play(Create(pc_original_interval, run_time=1.2, rate_func=rate_functions.ease_out_quart))
        # Animation component 3: 3.5s to 4.1s
        self.play(Succession(Wait(0.5), group=Group(), run_time=0.5))
        self.play(FadeIn(pc_first_removal, run_time=0.6, rate_func=rate_functions.ease_out_quart))
        # Animation component 4: 4.2s to 6.0s
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
        self.play(AnimationGroup(Transform(pc_first_removal, pc_ref_a1bebae4.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 2.81481477 / 2.0, 0.2074074 / 2.0), width=2.81481477, height=0.2074074).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.35).shift([0.0, 0.17777777, 0])).set_opacity(0.0), run_time=1.1, rate_func=rate_functions.ease_out_quart), Succession(Wait(0.6), AnimationGroup(Create(pc_first_left_interval, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_first_right_interval, run_time=1.2, rate_func=rate_functions.ease_out_quart), lag_ratio=0, run_time=1.2), group=Group(), run_time=1.8), Succession(Wait(1.0), FadeIn(pc_second_removal, run_time=0.7, rate_func=rate_functions.ease_out_quart), group=Group(), run_time=1.7), group=Group(), lag_ratio=0, run_time=1.8))
        # Animation component 5: 6.4s to 7.2s
        self.play(Succession(Wait(0.4), group=Group(), run_time=0.4))
        self.play(FadeIn(pc_recursive_note, run_time=0.8, rate_func=rate_functions.ease_out_quart))
        # Animation component 6: 7.4s to 9.5s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(AnimationGroup(Transform(pc_second_removal, pc_ref_addb316e.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 0.94814813 / 2.0, 0.17777777 / 2.0), width=0.94814813, height=0.17777777).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.3).shift([-2.81481477, -0.6074074, 0])).set_opacity(0.0), run_time=1.0, rate_func=rate_functions.ease_out_quart), Succession(Wait(0.7), AnimationGroup(Create(pc_second_generation_i, run_time=1.4, rate_func=rate_functions.ease_out_quart), Create(pc_second_generation_ii, run_time=1.4, rate_func=rate_functions.ease_out_quart), Create(pc_second_generation_iii, run_time=1.4, rate_func=rate_functions.ease_out_quart), Create(pc_second_generation_iv, run_time=1.4, rate_func=rate_functions.ease_out_quart), lag_ratio=0, run_time=1.4), group=Group(), run_time=2.1), group=Group(), lag_ratio=0, run_time=2.1))
        # Animation component 7: 10.6s to 11.8s
        self.play(Succession(Wait(1.1), group=Group(), run_time=1.1))
        self.play(AnimationGroup(Create(pc_third_generation_1, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_removal_1, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_generation_2, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_generation_3, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_removal_2, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_generation_4, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_generation_5, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_removal_3, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_generation_6, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_generation_7, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_removal_4, run_time=1.2, rate_func=rate_functions.ease_out_quart), Create(pc_third_generation_8, run_time=1.2, rate_func=rate_functions.ease_out_quart), lag_ratio=0, run_time=1.2))
        # Animation component 8: 12.0s to 13.1s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(AnimationGroup(Transform(pc_third_removal_1, pc_ref_c6f19501.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32).shift([-3.7629629, -1.2148148, 0])).set_opacity(0.0), run_time=1.1, rate_func=rate_functions.ease_out_quart), Transform(pc_third_removal_2, pc_ref_ecf40f6a.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32).shift([-1.86666664, -1.2148148, 0])).set_opacity(0.0), run_time=1.1, rate_func=rate_functions.ease_out_quart), Transform(pc_third_removal_3, pc_ref_12f689d3.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32).shift([1.86666664, -1.2148148, 0])).set_opacity(0.0), run_time=1.1, rate_func=rate_functions.ease_out_quart), Transform(pc_third_removal_4, pc_ref_38f9043c.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 0.29629629 / 2.0, 0.14814815 / 2.0), width=0.29629629, height=0.14814815).set_fill("#252722", opacity=1.0).set_stroke("#71402d", width=1.75).set_opacity(0.32).shift([3.7629629, -1.2148148, 0])).set_opacity(0.0), run_time=1.1, rate_func=rate_functions.ease_out_quart), lag_ratio=0, run_time=1.1))
        # Animation component 9: 13.2s to 14.0s
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
        self.play(Transform(self.camera.frame, Rectangle(width=config.frame_width / 1.05, height=config.frame_height / 1.05).move_to([0.0, -0.22222222, 0]).rotate(0.0 * DEGREES), run_time=0.8, rate_func=rate_functions.ease_out_quart))
        # Animation component 10: 14.2s to 15.9s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(Write(pc_surviving_length_equation, run_time=1.7, rate_func=rate_functions.ease_out_quart))
        # Animation component 11: 17.2s to 18.5s
        self.play(Succession(Wait(1.3), group=Group(), run_time=1.3))
        self.play(Indicate(pc_limit_of_surviving_length, color="#71402d", scale_factor=1.08, run_time=1.3, rate_func=rate_functions.there_and_back))
        # Animation component 12: 19.0s to 20.5s
        self.play(Succession(Wait(0.5), group=Group(), run_time=0.5))
        self.play(Succession(FadeIn(pc_measure_note, run_time=1.1, rate_func=rate_functions.ease_out_quart), Transform(pc_measure_note, pc_ref_2b60b10e.copy().shift([0.29629629, 0.0, 0]).set_opacity(1.0), run_time=0.0, rate_func=linear), Transform(pc_measure_note, pc_ref_2b60b10e.copy().set_opacity(1.0), run_time=0.4, rate_func=(lambda x: proofcanvas_cubic_bezier(x, 0.22, 0.72, 0.34, 1.0))), group=Group(), run_time=1.5))
        # Animation component 13: 20.5s to 21.0s
        self.play(Transform(pc_measure_note, pc_ref_2b60b10e.copy().set_opacity(1.0), run_time=0.5, rate_func=rush_from))
        self.clear()

        # Shot 2: Finite bookkeeping
        self.next_section("Finite bookkeeping")
        self.camera.background_color = "#f3eedf"
        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))
        pc_what_disappears = Text("What disappears at each stage?", font_size=36.0).set_color("#252722")
        pc_what_disappears.scale(min(6.51851842 / max(pc_what_disappears.width, 0.001), 0.7111111 / max(pc_what_disappears.height, 0.001)))
        pc_what_disappears.shift([-3.40740735, 2.96296292, 0])
        pc_ref_0c842ac0 = pc_what_disappears.copy()
        pc_removed_length = MathTex("\\frac{1}{3}+2\\cdot\\frac{1}{9}+4\\cdot\\frac{1}{27}+...=1", font_size=30.0).set_color("#315866")
        pc_removed_length.scale(min(6.81481471 / max(pc_removed_length.width, 0.001), 0.8148148 / max(pc_removed_length.height, 0.001)))
        pc_removed_length.shift([-3.40740735, 1.85185182, 0])
        pc_ref_d4cdc2d3 = pc_removed_length.copy()
        pc_removed_pieces_brace = VGroup(BraceBetweenPoints([-4.14814808, 0, 0], [4.14814808, 0, 0], direction=DOWN, buff=0.17777777).set_color("#71402d").set_stroke("#71402d", width=2.0), Text("2^{n-1} pieces, each of length 3^{-n}", font_size=22.0).set_color("#71402d").shift(DOWN * 0.7111111))
        pc_removed_pieces_brace.shift([-0.14814815, 0.56296295, 0])
        pc_ref_ff9c74ff = pc_removed_pieces_brace.copy()
        pc_left_survivor = RoundedRectangle(corner_radius=min(0.01481481, 2.44444441 / 2.0, 0.26666666 / 2.0), width=2.44444441, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.88)
        pc_left_survivor.shift([-3.25925921, -0.88888888, 0])
        pc_ref_19fc0d70 = pc_left_survivor.copy()
        pc_middle_left_survivor = RoundedRectangle(corner_radius=min(0.01481481, 0.8148148 / 2.0, 0.26666666 / 2.0), width=0.8148148, height=0.26666666).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_middle_left_survivor.shift([-1.11111109, -0.88888888, 0])
        pc_ref_c224b988 = pc_middle_left_survivor.copy()
        pc_middle_right_survivor = RoundedRectangle(corner_radius=min(0.01481481, 0.8148148 / 2.0, 0.26666666 / 2.0), width=0.8148148, height=0.26666666).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75)
        pc_middle_right_survivor.shift([1.11111109, -0.88888888, 0])
        pc_ref_62e1757b = pc_middle_right_survivor.copy()
        pc_right_survivor = RoundedRectangle(corner_radius=min(0.01481481, 2.44444441 / 2.0, 0.26666666 / 2.0), width=2.44444441, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.88)
        pc_right_survivor.shift([3.25925921, -0.88888888, 0])
        pc_ref_b995ae73 = pc_right_survivor.copy()
        pc_finite_stage_intervals = VGroup(pc_left_survivor, pc_middle_left_survivor, pc_middle_right_survivor, pc_right_survivor)
        pc_conservation_arrow = Arrow([-2.44444441, 0, 0], [2.44444441, 0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=ArrowTriangleFilledTip).set_cap_style(CapStyleType.BUTT).set_color("#71402d").set_stroke("#71402d", width=2.0)
        pc_conservation_arrow.shift([0.0, -2.0296296, 0])
        pc_ref_ee48b741 = pc_conservation_arrow.copy()
        pc_finite_versus_limit_note = Text("Every finite stage still has positive length.\nThe limit is the delicate step.", font_size=19.0).set_color("#4f534c")
        pc_finite_versus_limit_note.scale(min(7.70370358 / max(pc_finite_versus_limit_note.width, 0.001), 0.85925925 / max(pc_finite_versus_limit_note.height, 0.001)))
        pc_finite_versus_limit_note.shift([-2.7407407, -3.03703699, 0])
        pc_ref_95002778 = pc_finite_versus_limit_note.copy()
        # Animation component 1: 0.0s to 0.8s
        self.play(Write(pc_what_disappears, run_time=0.8, rate_func=rate_functions.ease_out_quart))
        # Animation component 2: 1.0s to 2.0s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(Write(pc_removed_length, run_time=1.0, rate_func=rate_functions.ease_out_quart))
        # Animation component 3: 2.2s to 3.0s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(Create(pc_removed_pieces_brace, run_time=0.8, rate_func=rate_functions.ease_out_quart))
        # Animation component 4: 3.2s to 4.2s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(Create(pc_finite_stage_intervals, run_time=1.0, rate_func=rate_functions.ease_out_quart))
        # Animation component 5: 4.5s to 5.1s
        self.play(Succession(Wait(0.3), group=Group(), run_time=0.3))
        self.play(Create(pc_conservation_arrow, run_time=0.6, rate_func=rate_functions.ease_out_quart))
        # Animation component 6: 5.2s to 6.0s
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
        self.play(FadeIn(pc_finite_versus_limit_note, run_time=0.8, rate_func=rate_functions.ease_out_quart))
        # Animation component 7: 6.1s to 7.0s
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
        self.play(AnimationGroup(Succession(Transform(pc_finite_versus_limit_note, pc_ref_95002778.copy().shift([0.0, -0.14814815, 0]).set_opacity(1.0), run_time=0.0, rate_func=linear), Transform(pc_finite_versus_limit_note, pc_ref_95002778.copy().set_opacity(1.0), run_time=0.9, rate_func=(lambda x: proofcanvas_cubic_bezier(x, 0.22, 0.72, 0.34, 1.0))), group=Group(), run_time=0.9), Succession(Wait(0.1), Transform(self.camera.frame, Rectangle(width=config.frame_width / 1.12, height=config.frame_height / 1.12).move_to([0.0, -0.8148148, 0]).rotate(0.0 * DEGREES), run_time=0.8, rate_func=rate_functions.ease_out_quart), group=Group(), run_time=0.9), group=Group(), lag_ratio=0, run_time=0.9))
        # Animation component 8: 7.0s to 8.0s
        self.play(Transform(pc_finite_versus_limit_note, pc_ref_95002778.copy().set_opacity(1.0), run_time=1.0, rate_func=rush_from))
        self.clear()

        # Shot 3: Infinite addresses
        self.next_section("Infinite addresses")
        self.camera.background_color = "#f3eedf"
        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))
        pc_infinite_addresses = Text("An address for every surviving point", font_size=35.0).set_color("#252722")
        pc_infinite_addresses.scale(min(6.51851842 / max(pc_infinite_addresses.width, 0.001), 0.7111111 / max(pc_infinite_addresses.height, 0.001)))
        pc_infinite_addresses.shift([-3.48148143, 2.93333329, 0])
        pc_ref_d9142454 = pc_infinite_addresses.copy()
        pc_ternary_expansion = MathTex("x=0.a_1a_2a_3...{}_3", font_size=34.0).set_color("#315866")
        pc_ternary_expansion.scale(min(6.96296285 / max(pc_ternary_expansion.width, 0.001), 0.8148148 / max(pc_ternary_expansion.height, 0.001)))
        pc_ternary_expansion.shift([-3.11111106, 1.77777775, 0])
        pc_ref_814d1da5 = pc_ternary_expansion.copy()
        pc_digit_choices = MathTex("a_k=0\\text{ or }2", font_size=31.0).set_color("#315866")
        pc_digit_choices.scale(min(4.59259252 / max(pc_digit_choices.width, 0.001), 0.7111111 / max(pc_digit_choices.height, 0.001)))
        pc_digit_choices.shift([-2.29629626, 0.51851851, 0])
        pc_ref_5c8b1507 = pc_digit_choices.copy()
        pc_binary_choice_brace = VGroup(BraceBetweenPoints([-2.44444441, 0, 0], [2.44444441, 0, 0], direction=DOWN, buff=0.17777777).set_color("#71402d").set_stroke("#71402d", width=2.0), Text("left or right, forever", font_size=22.0).set_color("#71402d").shift(DOWN * 0.62222221))
        pc_binary_choice_brace.shift([0.0, -0.17777777, 0])
        pc_ref_9003832b = pc_binary_choice_brace.copy()
        pc_choose_left = Arrow([-1.40740739, 0, 0], [1.40740739, 0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=ArrowTriangleFilledTip).set_cap_style(CapStyleType.BUTT).set_color("#315866").set_stroke("#315866", width=2.0)
        pc_choose_left.rotate(12.0 * DEGREES, about_point=ORIGIN)
        pc_choose_left.shift([-2.14814811, -1.25925924, 0])
        pc_ref_debe7e9b = pc_choose_left.copy()
        pc_choose_right = Arrow([-1.40740739, 0, 0], [1.40740739, 0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=ArrowTriangleFilledTip).set_cap_style(CapStyleType.BUTT).set_color("#71402d").set_stroke("#71402d", width=2.0)
        pc_choose_right.rotate(-12.0 * DEGREES, about_point=ORIGIN)
        pc_choose_right.shift([2.14814811, -1.25925924, 0])
        pc_ref_5746aa30 = pc_choose_right.copy()
        pc_zero_branch = Text("0 — keep left third", font_size=17.0).set_color("#315866")
        pc_zero_branch.scale(min(2.66666662 / max(pc_zero_branch.width, 0.001), 0.47407407 / max(pc_zero_branch.height, 0.001)))
        pc_zero_branch.shift([-3.18518514, -2.29629626, 0])
        pc_ref_8ad7fcf4 = pc_zero_branch.copy()
        pc_two_branch = Text("2 — keep right third", font_size=17.0).set_color("#71402d")
        pc_two_branch.scale(min(2.81481477 / max(pc_two_branch.width, 0.001), 0.47407407 / max(pc_two_branch.height, 0.001)))
        pc_two_branch.shift([2.07407404, -2.29629626, 0])
        pc_ref_0838100f = pc_two_branch.copy()
        pc_cardinality_note = Text("Infinite binary choices cannot be listed one by one.", font_size=22.0).set_color("#315866")
        pc_cardinality_note.scale(min(7.70370358 / max(pc_cardinality_note.width, 0.001), 0.65185184 / max(pc_cardinality_note.height, 0.001)))
        pc_cardinality_note.shift([-2.88888884, -3.33333328, 0])
        pc_ref_d096aecc = pc_cardinality_note.copy()
        # Animation component 1: 0.0s to 0.8s
        self.play(Write(pc_infinite_addresses, run_time=0.8, rate_func=rate_functions.ease_out_quart))
        # Animation component 2: 1.0s to 2.0s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(Write(pc_ternary_expansion, run_time=1.0, rate_func=rate_functions.ease_out_quart))
        # Animation component 3: 2.2s to 2.9s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(Write(pc_digit_choices, run_time=0.7, rate_func=rate_functions.ease_out_quart))
        # Animation component 4: 3.0s to 3.6s
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
        self.play(Create(pc_binary_choice_brace, run_time=0.6, rate_func=rate_functions.ease_out_quart))
        # Animation component 5: 3.8s to 4.6s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(AnimationGroup(Create(pc_choose_left, run_time=0.8, rate_func=rate_functions.ease_out_quart), Create(pc_choose_right, run_time=0.8, rate_func=rate_functions.ease_out_quart), lag_ratio=0, run_time=0.8))
        # Animation component 6: 4.8s to 5.5s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(AnimationGroup(FadeIn(pc_zero_branch, run_time=0.7, rate_func=rate_functions.ease_out_quart), FadeIn(pc_two_branch, run_time=0.7, rate_func=rate_functions.ease_out_quart), lag_ratio=0, run_time=0.7))
        # Animation component 7: 5.7s to 7.4s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(AnimationGroup(Succession(FadeIn(pc_cardinality_note, run_time=0.8, rate_func=rate_functions.ease_out_quart), Transform(pc_cardinality_note, pc_ref_d096aecc.copy().set_opacity(1.0), run_time=0.0, rate_func=linear), Transform(pc_cardinality_note, pc_ref_d096aecc.copy().set_opacity(1.0), run_time=0.7, rate_func=(lambda x: proofcanvas_cubic_bezier(x, 0.22, 0.72, 0.34, 1.0))), group=Group(), run_time=1.5), Succession(Wait(1.0), Transform(self.camera.frame, Rectangle(width=config.frame_width / 1.08, height=config.frame_height / 1.08).move_to([0.0, -1.77777775, 0]).rotate(0.0 * DEGREES), run_time=0.7, rate_func=rate_functions.ease_out_quart), group=Group(), run_time=1.7), group=Group(), lag_ratio=0, run_time=1.7))
        # Animation component 8: 8.0s to 8.0s
        self.play(Succession(Wait(0.6), Transform(pc_cardinality_note, pc_ref_d096aecc.copy().set_opacity(1.0), run_time=0.0, rate_func=linear), group=Group(), run_time=0.6))
        self.clear()

        # Shot 4: The length ledger
        self.next_section("The length ledger")
        self.camera.background_color = "#f3eedf"
        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))
        pc_length_ledger = Text("The numerical pattern", font_size=36.0).set_color("#252722")
        pc_length_ledger.scale(min(6.37037027 / max(pc_length_ledger.width, 0.001), 0.7111111 / max(pc_length_ledger.height, 0.001)))
        pc_length_ledger.shift([-3.40740735, 3.02222218, 0])
        pc_ref_1405188f = pc_length_ledger.copy()
        pc_length_rule = MathTex("L_n=(2/3)^n", font_size=27.0).set_color("#315866")
        pc_length_rule.scale(min(3.85185179 / max(pc_length_rule.width, 0.001), 0.62222221 / max(pc_length_rule.height, 0.001)))
        pc_length_rule.shift([2.07407404, 2.81481477, 0])
        pc_ref_5f60b978 = pc_length_rule.copy()
        pc_stage_0_length_bar = RoundedRectangle(corner_radius=min(0.01481481, 6.22222213 / 2.0, 0.26666666 / 2.0), width=6.22222213, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9)
        pc_stage_0_length_bar.shift([0.66666666, 1.18518517, 0])
        pc_ref_f4a9fffb = pc_stage_0_length_bar.copy()
        pc_stage_0_value = MathTex("L_0=1", font_size=22.0).set_color("#4f534c")
        pc_stage_0_value.scale(min(3.03703699 / max(pc_stage_0_value.width, 0.001), 0.5037037 / max(pc_stage_0_value.height, 0.001)))
        pc_stage_0_value.shift([3.33333328, 1.2148148, 0])
        pc_ref_2776f09c = pc_stage_0_value.copy()
        pc_stage_1_length_bar = RoundedRectangle(corner_radius=min(0.01481481, 4.14814808 / 2.0, 0.26666666 / 2.0), width=4.14814808, height=0.26666666).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9)
        pc_stage_1_length_bar.shift([-0.37037036, 0.26666666, 0])
        pc_ref_cea78592 = pc_stage_1_length_bar.copy()
        pc_stage_1_value = MathTex("L_1=2/3", font_size=22.0).set_color("#4f534c")
        pc_stage_1_value.scale(min(3.03703699 / max(pc_stage_1_value.width, 0.001), 0.5037037 / max(pc_stage_1_value.height, 0.001)))
        pc_stage_1_value.shift([3.33333328, 0.29629629, 0])
        pc_ref_4d796b05 = pc_stage_1_value.copy()
        pc_stage_2_length_bar = RoundedRectangle(corner_radius=min(0.01481481, 2.77037033 / 2.0, 0.26666666 / 2.0), width=2.77037033, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9)
        pc_stage_2_length_bar.shift([-1.05925924, -0.65185184, 0])
        pc_ref_a8a50b29 = pc_stage_2_length_bar.copy()
        pc_stage_2_value = MathTex("L_2=4/9", font_size=22.0).set_color("#4f534c")
        pc_stage_2_value.scale(min(3.03703699 / max(pc_stage_2_value.width, 0.001), 0.5037037 / max(pc_stage_2_value.height, 0.001)))
        pc_stage_2_value.shift([3.33333328, -0.62222221, 0])
        pc_ref_737be56e = pc_stage_2_value.copy()
        pc_stage_3_length_bar = RoundedRectangle(corner_radius=min(0.01481481, 1.83703701 / 2.0, 0.26666666 / 2.0), width=1.83703701, height=0.26666666).set_fill("#252722", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9)
        pc_stage_3_length_bar.shift([-1.5259259, -1.57037035, 0])
        pc_ref_82a290c0 = pc_stage_3_length_bar.copy()
        pc_stage_3_value = MathTex("L_3=8/27", font_size=22.0).set_color("#4f534c")
        pc_stage_3_value.scale(min(3.03703699 / max(pc_stage_3_value.width, 0.001), 0.5037037 / max(pc_stage_3_value.height, 0.001)))
        pc_stage_3_value.shift([3.33333328, -1.54074072, 0])
        pc_ref_997e5fd7 = pc_stage_3_value.copy()
        pc_stage_4_length_bar = RoundedRectangle(corner_radius=min(0.01481481, 1.22962961 / 2.0, 0.26666666 / 2.0), width=1.22962961, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9)
        pc_stage_4_length_bar.shift([-1.8296296, -2.48888885, 0])
        pc_ref_8cb3e99f = pc_stage_4_length_bar.copy()
        pc_stage_4_value = MathTex("L_4=16/81", font_size=22.0).set_color("#71402d")
        pc_stage_4_value.scale(min(3.03703699 / max(pc_stage_4_value.width, 0.001), 0.5037037 / max(pc_stage_4_value.height, 0.001)))
        pc_stage_4_value.shift([3.33333328, -2.45925922, 0])
        pc_ref_8f6d06f8 = pc_stage_4_value.copy()
        pc_decreasing_sequence_arrow = Arrow([-0.23703703, 0, 0], [0.23703703, 0, 0], buff=0, max_tip_length_to_length_ratio=0.25, tip_shape=ArrowTriangleFilledTip).set_cap_style(CapStyleType.BUTT).set_color("#71402d").set_stroke("#71402d", width=2.0)
        pc_decreasing_sequence_arrow.rotate(-90.0 * DEGREES, about_point=ORIGIN)
        pc_decreasing_sequence_arrow.shift([5.11111103, -0.66666666, 0])
        pc_ref_2c64cb2e = pc_decreasing_sequence_arrow.copy()
        pc_convergence_note = Text("multiply by 2/3\neach time", font_size=18.0).set_color("#4f534c")
        pc_convergence_note.scale(min(3.70370365 / max(pc_convergence_note.width, 0.001), 0.62222221 / max(pc_convergence_note.height, 0.001)))
        pc_convergence_note.shift([2.81481477, -3.62962957, 0])
        pc_ref_696f6acf = pc_convergence_note.copy()
        # Animation component 1: 0.0s to 0.7s
        self.play(Write(pc_length_ledger, run_time=0.7, rate_func=rate_functions.ease_out_quart))
        # Animation component 2: 0.8s to 1.5s
        self.play(Succession(Wait(0.1), group=Group(), run_time=0.1))
        self.play(Write(pc_length_rule, run_time=0.7, rate_func=rate_functions.ease_out_quart))
        # Animation component 3: 1.7s to 2.05s
        self.play(Succession(Wait(0.2), group=Group(), run_time=0.2))
        self.play(Create(pc_stage_0_length_bar, run_time=0.35, rate_func=rate_functions.ease_out_quart))
        # Animation component 4: 2.05s to 2.35s
        self.play(Write(pc_stage_0_value, run_time=0.3, rate_func=rate_functions.ease_out_quart))
        # Animation component 5: 2.4s to 2.75s
        self.play(Succession(Wait(0.05), group=Group(), run_time=0.05))
        self.play(Create(pc_stage_1_length_bar, run_time=0.35, rate_func=rate_functions.ease_out_quart))
        # Animation component 6: 2.75s to 3.05s
        self.play(Write(pc_stage_1_value, run_time=0.3, rate_func=rate_functions.ease_out_quart))
        # Animation component 7: 3.1s to 3.45s
        self.play(Succession(Wait(0.05), group=Group(), run_time=0.05))
        self.play(Create(pc_stage_2_length_bar, run_time=0.35, rate_func=rate_functions.ease_out_quart))
        # Animation component 8: 3.45s to 3.75s
        self.play(Write(pc_stage_2_value, run_time=0.3, rate_func=rate_functions.ease_out_quart))
        # Animation component 9: 3.8s to 4.15s
        self.play(Succession(Wait(0.05), group=Group(), run_time=0.05))
        self.play(Create(pc_stage_3_length_bar, run_time=0.35, rate_func=rate_functions.ease_out_quart))
        # Animation component 10: 4.15s to 4.45s
        self.play(Write(pc_stage_3_value, run_time=0.3, rate_func=rate_functions.ease_out_quart))
        # Animation component 11: 4.5s to 4.85s
        self.play(Succession(Wait(0.05), group=Group(), run_time=0.05))
        self.play(Create(pc_stage_4_length_bar, run_time=0.35, rate_func=rate_functions.ease_out_quart))
        # Animation component 12: 4.85s to 5.15s
        self.play(Write(pc_stage_4_value, run_time=0.3, rate_func=rate_functions.ease_out_quart))
        # Animation component 13: 5.6s to 8.0s
        self.play(Succession(Wait(0.45), group=Group(), run_time=0.45))
        self.play(AnimationGroup(Create(pc_decreasing_sequence_arrow, run_time=0.5, rate_func=rate_functions.ease_out_quart), Succession(Wait(0.4), Transform(pc_stage_4_length_bar, pc_ref_8cb3e99f.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 1.4222222 / 2.0, 0.26666666 / 2.0), width=1.4222222, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9).shift([-1.8296296, -2.48888885, 0])).set_opacity(0.9), run_time=0.0, rate_func=linear), Transform(pc_stage_4_length_bar, pc_ref_8cb3e99f.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 1.22962961 / 2.0, 0.26666666 / 2.0), width=1.22962961, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9).shift([-1.8296296, -2.48888885, 0])).set_opacity(0.9), run_time=1.0, rate_func=(lambda x: proofcanvas_cubic_bezier(x, 0.22, 0.72, 0.34, 1.0))), group=Group(), run_time=1.4), Succession(Wait(0.6), FadeIn(pc_convergence_note, run_time=0.5, rate_func=rate_functions.ease_out_quart), group=Group(), run_time=1.1), Succession(Wait(1.3), Transform(self.camera.frame, Rectangle(width=config.frame_width / 1.1, height=config.frame_height / 1.1).move_to([0.29629629, -1.77777775, 0]).rotate(0.0 * DEGREES), run_time=0.6, rate_func=rate_functions.ease_out_quart), group=Group(), run_time=1.9), Succession(Wait(1.4), Transform(pc_stage_4_length_bar, pc_ref_8cb3e99f.copy().become(RoundedRectangle(corner_radius=min(0.01481481, 1.22962961 / 2.0, 0.26666666 / 2.0), width=1.22962961, height=0.26666666).set_fill("#315866", opacity=1.0).set_stroke("#252722", width=1.75).set_opacity(0.9).shift([-1.8296296, -2.48888885, 0])).set_opacity(0.9), run_time=1.0, rate_func=rush_from), group=Group(), run_time=2.4), group=Group(), lag_ratio=0, run_time=2.4))
        self.clear()

        # Shot 5: The paradox
        self.next_section("The paradox")
        self.camera.background_color = "#f3eedf"
        self.camera.frame.become(Rectangle(width=config.frame_width / 1.0, height=config.frame_height / 1.0).move_to([0.0, 0.0, 0]).rotate(0.0 * DEGREES))
        pc_the_contrast = Text("The contrast", font_size=38.0).set_color("#252722")
        pc_the_contrast.scale(min(5.77777769 / max(pc_the_contrast.width, 0.001), 0.66666666 / max(pc_the_contrast.height, 0.001)))
        pc_the_contrast.shift([-3.11111106, 2.51851848, 0])
        pc_ref_a884f76b = pc_the_contrast.copy()
        pc_uncountable = Text("uncountably many points", font_size=31.0).set_color("#315866")
        pc_uncountable.scale(min(5.33333325 / max(pc_uncountable.width, 0.001), 0.77037036 / max(pc_uncountable.height, 0.001)))
        pc_uncountable.shift([-2.66666662, 0.22222222, 0])
        pc_ref_40503791 = pc_uncountable.copy()
        pc_zero_length = Text("zero total length", font_size=30.0).set_color("#71402d")
        pc_zero_length.scale(min(4.29629623 / max(pc_zero_length.width, 0.001), 0.7111111 / max(pc_zero_length.height, 0.001)))
        pc_zero_length.shift([2.51851848, -1.33333331, 0])
        pc_ref_5f8970db = pc_zero_length.copy()
        pc_cantor_conclusion = MathTex("|C|=|[0,1]|,\\;m(C)=0", font_size=28.0).set_color("#252722")
        pc_cantor_conclusion.scale(min(6.37037027 / max(pc_cantor_conclusion.width, 0.001), 0.7111111 / max(pc_cantor_conclusion.height, 0.001)))
        pc_cantor_conclusion.shift([-2.44444441, -2.88888884, 0])
        pc_ref_02d47145 = pc_cantor_conclusion.copy()
        # Animation component 1: 0.0s to 1.0s
        self.play(Write(pc_the_contrast, run_time=1.0, rate_func=rate_functions.ease_out_quart))
        # Animation component 2: 1.4s to 2.6s
        self.play(Succession(Wait(0.4), group=Group(), run_time=0.4))
        self.play(FadeIn(pc_uncountable, run_time=1.2, rate_func=rate_functions.ease_out_quart))
        # Animation component 3: 3.2s to 4.4s
        self.play(Succession(Wait(0.6), group=Group(), run_time=0.6))
        self.play(FadeIn(pc_zero_length, run_time=1.2, rate_func=rate_functions.ease_out_quart))
        # Animation component 4: 4.8s to 7.0s
        self.play(Succession(Wait(0.4), group=Group(), run_time=0.4))
        self.play(AnimationGroup(Transform(self.camera.frame, Rectangle(width=config.frame_width / 1.08, height=config.frame_height / 1.08).move_to([0.29629629, -0.14814815, 0]).rotate(0.0 * DEGREES), run_time=1.2, rate_func=rate_functions.ease_out_quart), Succession(Wait(1.0), Write(pc_cantor_conclusion, run_time=0.8, rate_func=rate_functions.ease_out_quart), Transform(pc_cantor_conclusion, pc_ref_02d47145.copy().set_opacity(1.0), run_time=0.0, rate_func=linear), Transform(pc_cantor_conclusion, pc_ref_02d47145.copy().set_opacity(1.0), run_time=0.4, rate_func=(lambda x: proofcanvas_cubic_bezier(x, 0.22, 0.72, 0.34, 1.0))), group=Group(), run_time=2.2), group=Group(), lag_ratio=0, run_time=2.2))
