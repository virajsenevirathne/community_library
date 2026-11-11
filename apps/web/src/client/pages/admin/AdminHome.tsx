import { Layout } from "../../components.tsx";
import { Link } from "../../lib/router.tsx";

/** Staff home. The dashboard with loan numbers arrives with VIR-13. */
export function AdminHomePage() {
  return (
    <Layout title="Admin">
      <ul className="tiles">
        <li>
          <Link href="/admin/returns" className="tile">
            <strong>Check in returns</strong>
            <span>Scan the books in the returns basket</span>
          </Link>
        </li>
        <li>
          <Link href="/admin/add" className="tile">
            <strong>Add books</strong>
            <span>Scan a barcode or type the details</span>
          </Link>
        </li>
        <li>
          <Link href="/admin/catalog" className="tile">
            <strong>Catalog</strong>
            <span>Every book and copy, with its status</span>
          </Link>
        </li>
        <li>
          <Link href="/admin/labels" className="tile">
            <strong>Print labels</strong>
            <span>QR stickers for new copies</span>
          </Link>
        </li>
      </ul>
    </Layout>
  );
}
