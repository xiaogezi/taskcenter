import { redirect } from "vinext/shims/navigation";

export default function Home() {
  redirect("/tasks");
}
