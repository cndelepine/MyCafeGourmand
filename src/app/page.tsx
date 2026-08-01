import Image from "next/image";
import { meatballsSoup } from "@/content/recipes/meatballs-soup";

export default function Home() {
  const recipe = meatballsSoup;

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top">My Café Gourmand</a>
        <nav aria-label="Primary navigation">
          <a href="#recipe">Recipe</a>
          <a href="#ingredients">Ingredients</a>
          <a href="#method">Method</a>
        </nav>
        <div className="languages" aria-label="Available languages">
          <span className="active">EN</span><span>FR</span><span>RU</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">A recipe from the home kitchen</p>
          <h1>{recipe.title}</h1>
          <p className="intro">{recipe.description}</p>
          <a className="jump-link" href="#recipe">Cook this recipe <span aria-hidden="true">↓</span></a>
        </div>
        <div className="hero-art" aria-label="An illustrated bowl of meatball soup" role="img">
          <Image alt="A bowl of meatballs soup" className="hero-photo" fill priority sizes="(max-width: 700px) 100vw, 50vw" src={recipe.images.hero} />
          <div className="steam steam-one" /><div className="steam steam-two" /><div className="steam steam-three" />
          <div className="bowl"><i /><i /><i /><i /><i /><i /></div>
          <span className="herb herb-one">✦</span><span className="herb herb-two">✦</span>
        </div>
      </section>

      <article className="recipe" id="recipe">
        <div className="recipe-heading">
          <p className="eyebrow">{recipe.category}</p>
          <h2>Simple ingredients.<br />A generous bowl.</h2>
        </div>
        <dl className="details">
          <div><dt>Serves</dt><dd>{recipe.servings}</dd></div>
          <div><dt>Prep time</dt><dd>{recipe.prepTime}</dd></div>
          <div><dt>Language</dt><dd>English</dd></div>
        </dl>

        <section className="ingredients" id="ingredients">
          <div className="section-label"><span>01</span><h2>Ingredients</h2></div>
          <div className="ingredient-groups">
            {recipe.ingredients.map((group) => (
              <div className="ingredient-group" key={group.name}>
                <h3>{group.name}</h3>
                <ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            ))}
          </div>
        </section>

        <section className="method" id="method">
          <div className="section-label"><span>02</span><h2>Method</h2></div>
          <ol>{recipe.steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span><div><p>{step}</p>{recipe.images.steps[index] && <Image alt={`Step ${index + 1}: meatball preparation`} className="step-photo" height={592} src={recipe.images.steps[index]} width={800} />}</div></li>)}</ol>
        </section>
      </article>

      <footer>Made with care, one recipe at a time.</footer>
    </main>
  );
}
