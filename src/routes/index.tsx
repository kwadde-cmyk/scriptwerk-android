import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: function Home() {
    return null;
  },
});
