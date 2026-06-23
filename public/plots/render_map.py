import json
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.colors import to_rgba
import matplotlib.cm as cm
import numpy as np

# Load TopoJSON and decode manually using shapely + topojson decode
import topojson as tp

with open("canadaprovtopo.json") as f:
    topo = json.load(f)

# Use the topojson library to convert to GeoJSON
topo_obj = tp.Topology(topo, object_name="canadaprov")
gdf = topo_obj.to_gdf()

print(gdf.columns.tolist())
print(gdf.head())

# Plot 1 — basic outline
fig, ax = plt.subplots(figsize=(12, 8))
gdf.plot(ax=ax, color="#dddddd", edgecolor="white", linewidth=0.8)
ax.set_axis_off()
ax.set_title("Canada — Provinces Outline", fontsize=16)
plt.tight_layout()
plt.savefig("canada_outline.png", dpi=150, bbox_inches="tight")
print("Saved canada_outline.png")

# Plot 2 — filled by province name
fig, ax = plt.subplots(figsize=(12, 8))
gdf["color_idx"] = range(len(gdf))
gdf.plot(ax=ax, column="color_idx", cmap="tab20", edgecolor="white", linewidth=0.8)
for _, row in gdf.iterrows():
    centroid = row.geometry.centroid
    ax.annotate(row.get("name", ""), xy=(centroid.x, centroid.y),
                ha="center", fontsize=6, color="black")
ax.set_axis_off()
ax.set_title("Canada — Provinces by Name", fontsize=16)
plt.tight_layout()
plt.savefig("canada_filled.png", dpi=150, bbox_inches="tight")
print("Saved canada_filled.png")
