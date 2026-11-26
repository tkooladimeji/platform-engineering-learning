import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ProductInput, StockedProduct } from "../../shared/contracts";
import { api } from "./api";

const emptyForm = { name: "", sku: "", description: "", quantity: "0" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred. Check the service logs.";
}

function parseQuantity(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("Quantity must be a non-negative whole number.");
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity)) throw new Error("Quantity is too large.");
  return quantity;
}

export function App() {
  const [products, setProducts] = useState<StockedProduct[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [stockInputs, setStockInputs] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const disabled = busy || loading;

  useEffect(() => {
    const controller = new AbortController();
    api.list(controller.signal)
      .then((items) => {
        setProducts(items);
        setStockInputs(Object.fromEntries(items.map((item) => [item.id, String(item.quantity)])));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function mutate(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function replaceProduct(product: StockedProduct): void {
    setProducts((items) => items.map((item) => item.id === product.id ? product : item));
    setStockInputs((inputs) => ({ ...inputs, [product.id]: String(product.quantity) }));
  }

  function resetForm(): void {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await mutate(async () => {
      const input: ProductInput = { name: form.name, sku: form.sku, description: form.description };
      if (editingId) {
        replaceProduct(await api.update(editingId, input));
        setNotice("Product details updated.");
      } else {
        const created = await api.create({ ...input, quantity: parseQuantity(form.quantity) });
        setProducts((items) => [...items, created]);
        setStockInputs((inputs) => ({ ...inputs, [created.id]: String(created.quantity) }));
        setNotice("Product added to your stockroom.");
      }
      resetForm();
    });
  }

  function editProduct(product: StockedProduct): void {
    setEditingId(product.id);
    setForm({ name: product.name, sku: product.sku, description: product.description, quantity: String(product.quantity) });
    setError("");
    setNotice("");
    nameInput.current?.focus();
    nameInput.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function removeProduct(product: StockedProduct): Promise<void> {
    if (!window.confirm(`Delete "${product.name}" and its stock record? This cannot be undone.`)) return;
    await mutate(async () => {
      await api.remove(product.id);
      setProducts((items) => items.filter((item) => item.id !== product.id));
      setStockInputs((inputs) => {
        const next = { ...inputs };
        delete next[product.id];
        return next;
      });
      if (editingId === product.id) resetForm();
      setNotice("Product and stock record deleted.");
    });
  }

  async function refresh(): Promise<void> {
    await mutate(async () => {
      const items = await api.list();
      setProducts(items);
      setStockInputs(Object.fromEntries(items.map((item) => [item.id, String(item.quantity)])));
      resetForm();
      setNotice("Inventory refreshed.");
    });
  }

  const term = search.trim().toLowerCase();
  const visibleProducts = products.filter((product) =>
    `${product.name} ${product.sku} ${product.description}`.toLowerCase().includes(term));
  const totalUnits = products.reduce((total, product) => total + BigInt(product.quantity), 0n);
  const outOfStock = products.filter((product) => product.quantity === 0).length;

  return (
    <div className="app-shell">
      <header className="header">
        <a className="brand" href="/" aria-label="Stockroom home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>stockroom<span className="brand-dot">.</span></span>
        </a>
        <span className="environment"><span aria-hidden="true" />Local learning project</span>
      </header>

      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">INVENTORY WORKSPACE</p>
            <h1>Everything in stock.<br /><span>Everything in view.</span></h1>
            <p className="subtitle">A simple home for your products, quantities, and everyday updates.</p>
          </div>
          <div className="memory-note">
            <span className="note-label">IN-MEMORY MODE</span>
            <p>Data lives only while the services are running. Restart all services together to reset.</p>
          </div>
        </section>

        <section className="stats" aria-label="Inventory overview">
          <div className="stat"><span>Products</span><strong>{products.length}</strong><small>In your catalog</small></div>
          <div className="stat"><span>Total units</span><strong>{totalUnits.toLocaleString()}</strong><small>Across all products</small></div>
          <div className="stat"><span>Out of stock</span><strong>{outOfStock}</strong><small>Products needing a restock</small></div>
        </section>

        {error && <div className="message error" role="alert">{error}</div>}
        {notice && <div className="message success" role="status">{notice}</div>}

        <div className="workspace">
          <section className="panel product-form">
            <p className="eyebrow">{editingId ? "MAKE A CHANGE" : "GROW YOUR CATALOG"}</p>
            <h2>{editingId ? "Edit product" : "New product"}</h2>
            <p className="panel-description">{editingId ? "Update the details. Set stock in the inventory table." : "Add the details, then set your opening stock."}</p>
            <form onSubmit={saveProduct}>
              <fieldset disabled={disabled}>
                <label htmlFor="product-name">Product name</label>
                <input ref={nameInput} id="product-name" required maxLength={120} value={form.name}
                  placeholder="e.g. Everyday notebook"
                  onChange={(event) => setForm({ ...form, name: event.target.value })} />
                <label htmlFor="product-sku">SKU</label>
                <input id="product-sku" required maxLength={64} pattern="[A-Za-z0-9_-]+"
                  title="Letters, numbers, hyphens and underscores only" value={form.sku}
                  placeholder="e.g. NOTE-001"
                  onChange={(event) => setForm({ ...form, sku: event.target.value })} />
                <label htmlFor="product-description">Description <span className="optional">optional</span></label>
                <textarea id="product-description" maxLength={1000} rows={3} value={form.description}
                  placeholder="A little more about this product"
                  onChange={(event) => setForm({ ...form, description: event.target.value })} />
                {!editingId && <>
                  <label htmlFor="product-quantity">Opening quantity</label>
                  <input id="product-quantity" type="number" min="0" max={Number.MAX_SAFE_INTEGER} step="1"
                    required value={form.quantity}
                    onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
                </>}
                <button className="primary" type="submit">{busy ? "Saving..." : editingId ? "Save details" : "Add product"}</button>
                {editingId && <button className="secondary cancel" type="button" onClick={resetForm}>Cancel editing</button>}
              </fieldset>
            </form>
          </section>

          <section className="panel inventory-panel" aria-busy={disabled}>
            <div className="panel-heading">
              <div><p className="eyebrow">YOUR STOCKROOM</p><h2>Product inventory</h2></div>
              <button className="secondary" type="button" disabled={disabled} onClick={refresh}>Refresh</button>
            </div>
            <label className="search-label" htmlFor="search">Find a product</label>
            <input className="search" id="search" type="search" placeholder="Search by name, SKU, or description..."
              value={search} onChange={(event) => setSearch(event.target.value)} />
            {loading ? <div className="empty-state">Loading your inventory...</div> : visibleProducts.length === 0 ? (
              <div className="empty-state">
                <span className="empty-mark" aria-hidden="true">[]</span>
                <h3>{error ? "Inventory could not be loaded" : term ? "No matching products" : "Your shelves are ready"}</h3>
                <p>{error ? "Check the services and use Refresh to try again." : term ? "Try another name or SKU." : "Add your first product using the form to get started."}</p>
              </div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th scope="col">Product</th><th scope="col">Stock</th><th scope="col">Actions</th></tr></thead>
                  <tbody>
                    {visibleProducts.map((product) => (
                      <tr key={product.id}>
                        <td>
                          <span className="product-name">{product.name}</span>
                          <span className="sku">{product.sku}</span>
                          {product.description && <span className="description">{product.description}</span>}
                        </td>
                        <td>
                          <span className={`stock-badge ${product.quantity === 0 ? "out" : ""}`}>
                            {product.quantity === 0 ? "Out of stock" : `${product.quantity.toLocaleString()} in stock`}
                          </span>
                          <form className="stock-form" onSubmit={(event) => {
                            event.preventDefault();
                            void mutate(async () => {
                              const quantity = parseQuantity(stockInputs[product.id] ?? "");
                              replaceProduct(await api.quantity(product.id, quantity));
                              setNotice(`Quantity updated for ${product.name}.`);
                            });
                          }}>
                            <label className="visually-hidden" htmlFor={`stock-${product.id}`}>Quantity for {product.name}</label>
                            <input id={`stock-${product.id}`} type="number" min="0" max={Number.MAX_SAFE_INTEGER}
                              step="1" required disabled={disabled} value={stockInputs[product.id] ?? ""}
                              onChange={(event) => setStockInputs({ ...stockInputs, [product.id]: event.target.value })} />
                            <button type="submit" className="secondary" disabled={disabled}>Set</button>
                          </form>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button type="button" className="text-button" disabled={disabled} onClick={() => editProduct(product)}
                              aria-label={`Edit ${product.name}`}>Edit</button>
                            <button type="button" className="text-button danger" disabled={disabled} onClick={() => removeProduct(product)}
                              aria-label={`Delete ${product.name}`}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="table-footer">{visibleProducts.length} of {products.length} products<span>Changes are saved to local memory</span></p>
          </section>
        </div>
      </main>
      <footer className="footer">Stockroom / Learning Kubernetes<span>React + three independent backend services</span></footer>
    </div>
  );
}
