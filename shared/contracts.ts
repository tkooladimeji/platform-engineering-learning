export interface ProductInput {
  name: string;
  sku: string;
  description: string;
}

export interface Product extends ProductInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface Stock {
  productId: string;
  quantity: number;
  updatedAt: string;
}

export interface StockedProduct extends Product {
  quantity: number;
  stockUpdatedAt: string;
}

export interface CreateProductInput extends ProductInput {
  quantity: number;
}
