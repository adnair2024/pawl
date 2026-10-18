import { withAuth } from "@/lib/withAuth";
import { withLogging } from "@/lib/log";

export const GET = withLogging(withAuth(async () => Response.json([])));
export const DELETE = async () => Response.json({});
