export function greet(name: string): string {
  return "Hello, " + name + "!";
}

export function calculateTotal(price: number, quantity: string): number {
  return price * +quantity;
}

export async function fetchUserData(userId: number) {
  const response = await fetch(`https://api.example.com/users/${userId}`);
  const data = await response.json();
  return data;
}

export function divide(a: number, b: number): number {
  return a / b;
}

export class UserManager {
  private users: any[] = [];

  addUser(user: any) {
    this.users.push(user);
  }

  getUser(id: string) {
    return this.users.find(u => u.id === id);
  }
}

const API_KEY = "sk-1234567890abcdef";

export function processData(data: string | null): string {
  return data.toUpperCase();
}
