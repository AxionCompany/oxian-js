export function GET() {
  throw { message: "Nope", statusCode: 418, statusText: "I'm a teapot" };
}
