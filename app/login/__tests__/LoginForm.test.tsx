import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TextEncoder } from "node:util";
import LoginForm from "../LoginForm";

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
});

test("applies the documented UTF-8 byte policy without rejecting a valid multibyte password by character count", async () => {
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ csrfToken: "C".repeat(43) }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ message: "Password was not accepted" }) });
  render(<LoginForm configured />);
  const input = await screen.findByLabelText("Owner password");
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).not.toHaveAttribute("minlength");

  fireEvent.change(input, { target: { value: "🙂🙂🙂" } });
  fireEvent.submit(input.closest("form")!);
  expect(screen.getByRole("alert")).toHaveTextContent("16–1024 UTF-8 bytes");
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fireEvent.change(input, { target: { value: "🙂🙂🙂🙂" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ password: "🙂🙂🙂🙂" });
});
